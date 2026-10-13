"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Eye, Save, XCircle } from "lucide-react";
import { Button, Field, Input, Select, useToast } from "@recx/design";
import { PRESET_KEYS, PRESETS, RADII, type PresetKey, type Radius } from "@recx/design/presets";
import { previewBrandTheme, saveBrandTheme, type BrandPreview } from "@/server/actions/super-branding";
import { ReasonDialog } from "@/components/super/reason-dialog";

type PresetChoice = PresetKey | "custom";

const SWATCH_KEYS = ["background", "surface", "text", "primary", "primary-subtle", "accent", "accent-subtle", "ring"] as const;

/**
 * Brand theme editor: a preset or two custom seed colours plus a radius.
 * Preview derives the palette on the server and shows every contrast check
 * (both themes) and a colour-vision simulation; Save refuses a failing
 * palette. Status colours are never themeable.
 */
export function BrandingForm({
  initial,
}: {
  initial: { presetKey: string; brandSeed: string; accentSeed: string; radius: string };
}) {
  const router = useRouter();
  const { toast } = useToast();
  const id = useId();
  const initialPreset = (PRESET_KEYS as readonly string[]).includes(initial.presetKey)
    ? (initial.presetKey as PresetKey)
    : "custom";
  const [presetKey, setPresetKey] = useState<PresetChoice>(initialPreset);
  const [brandSeed, setBrandSeed] = useState(initial.brandSeed.toLowerCase());
  const [accentSeed, setAccentSeed] = useState(initial.accentSeed.toLowerCase());
  const [radius, setRadius] = useState<Radius>(
    (RADII as readonly string[]).includes(initial.radius) ? (initial.radius as Radius) : "0.75rem",
  );
  const [preview, setPreview] = useState<BrandPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pending, startTransition] = useTransition();

  const theme = () => {
    const seeds = presetKey === "custom" ? { brandSeed, accentSeed } : PRESETS[presetKey];
    return { presetKey, brandSeed: seeds.brandSeed, accentSeed: seeds.accentSeed, radius };
  };

  const runPreview = () =>
    startTransition(async () => {
      setError(null);
      const result = await previewBrandTheme(theme());
      if (result.ok) setPreview(result.data);
      else {
        setPreview(null);
        setError(result.error);
      }
    });

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Preset" htmlFor={`${id}-preset`}>
          <Select
            id={`${id}-preset`}
            value={presetKey}
            onChange={(e) => {
              setPresetKey(e.target.value as PresetChoice);
              setPreview(null);
            }}
          >
            {PRESET_KEYS.map((key) => (
              <option key={key} value={key}>
                {PRESETS[key].label}
              </option>
            ))}
            <option value="custom">Custom colours</option>
          </Select>
        </Field>
        <Field label="Brand colour" htmlFor={`${id}-brand`} hint={presetKey === "custom" ? undefined : "Set by the preset"}>
          <Input
            id={`${id}-brand`}
            type="color"
            className="h-10 p-1"
            value={presetKey === "custom" ? brandSeed : PRESETS[presetKey].brandSeed}
            disabled={presetKey !== "custom"}
            onChange={(e) => {
              setBrandSeed(e.target.value.toLowerCase());
              setPreview(null);
            }}
          />
        </Field>
        <Field label="Accent colour" htmlFor={`${id}-accent`} hint={presetKey === "custom" ? undefined : "Set by the preset"}>
          <Input
            id={`${id}-accent`}
            type="color"
            className="h-10 p-1"
            value={presetKey === "custom" ? accentSeed : PRESETS[presetKey].accentSeed}
            disabled={presetKey !== "custom"}
            onChange={(e) => {
              setAccentSeed(e.target.value.toLowerCase());
              setPreview(null);
            }}
          />
        </Field>
        <Field label="Corner radius" htmlFor={`${id}-radius`}>
          <Select
            id={`${id}-radius`}
            value={radius}
            onChange={(e) => {
              setRadius(e.target.value as Radius);
              setPreview(null);
            }}
          >
            {RADII.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={runPreview} loading={pending}>
          <Eye className="h-4 w-4" aria-hidden />
          Preview
        </Button>
        <Button onClick={() => setSaving(true)} disabled={!preview?.ok}>
          <Save className="h-4 w-4" aria-hidden />
          Save theme
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      {preview ? (
        <div className="space-y-4" aria-live="polite">
          <p className={`flex items-center gap-2 text-sm font-semibold ${preview.ok ? "text-success" : "text-danger"}`}>
            {preview.ok ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : <XCircle className="h-4 w-4" aria-hidden />}
            {preview.ok
              ? "Every contrast check passes in both themes."
              : `${preview.failures.length} contrast check(s) fail. This theme cannot be saved.`}
          </p>
          {preview.warnings.length > 0 ? (
            <ul className="list-disc space-y-1 pl-5 text-sm text-text-secondary">
              {preview.warnings.map((w, i) => (
                <li key={i}>{w.message}</li>
              ))}
            </ul>
          ) : null}
          {preview.palette ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {(["light", "dark"] as const).map((mode) => (
                <div key={mode} className="rounded-xl border border-border p-3">
                  <p className="mb-2 text-sm font-semibold capitalize">{mode} theme</p>
                  <ul className="grid grid-cols-2 gap-2 text-xs">
                    {SWATCH_KEYS.map((key) => (
                      <li key={key} className="flex items-center gap-2">
                        <span
                          aria-hidden
                          className="h-6 w-6 shrink-0 rounded border border-border-strong"
                          style={{ backgroundColor: preview.palette?.[mode][key] }}
                        />
                        <span className="min-w-0">
                          {key} <span className="font-mono text-text-secondary">{preview.palette?.[mode][key]}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ) : null}
          {preview.simulations.length > 0 ? (
            <div tabIndex={0} aria-label="Colour-vision simulation" className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full min-w-[28rem] text-left text-xs">
                <caption className="sr-only">How the primary and accent colours read under colour-vision simulations</caption>
                <thead className="bg-primary-subtle/40 uppercase tracking-wide text-text-secondary">
                  <tr>
                    <th scope="col" className="px-3 py-2">Simulation</th>
                    <th scope="col" className="px-3 py-2">Light primary / accent</th>
                    <th scope="col" className="px-3 py-2">Dark primary / accent</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.simulations.map((s) => (
                    <tr key={s.type} className="border-t border-border">
                      <th scope="row" className="px-3 py-2 font-medium">
                        {s.type}
                      </th>
                      {(["light", "dark"] as const).map((mode) => (
                        <td key={mode} className="px-3 py-2">
                          <span className="inline-flex items-center gap-1">
                            <span aria-hidden className="h-4 w-4 rounded border border-border-strong" style={{ backgroundColor: s[mode].primary }} />
                            <span aria-hidden className="h-4 w-4 rounded border border-border-strong" style={{ backgroundColor: s[mode].accent }} />
                            <span className="font-mono">
                              {s[mode].primary} / {s[mode].accent}
                            </span>
                          </span>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <div tabIndex={0} aria-label="Contrast checks" className="max-h-80 overflow-auto rounded-xl border border-border">
            <table className="w-full min-w-[28rem] text-left text-xs">
              <caption className="sr-only">Contrast checks in both themes</caption>
              <thead className="sticky top-0 bg-surface uppercase tracking-wide text-text-secondary">
                <tr>
                  <th scope="col" className="px-3 py-2">Theme</th>
                  <th scope="col" className="px-3 py-2">Pair</th>
                  <th scope="col" className="px-3 py-2">Ratio</th>
                  <th scope="col" className="px-3 py-2">Result</th>
                </tr>
              </thead>
              <tbody>
                {preview.checks.map((c, i) => (
                  <tr key={i} className="border-t border-border">
                    <td className="px-3 py-1.5">{c.theme}</td>
                    <td className="px-3 py-1.5">
                      {c.fg} on {c.bg}
                    </td>
                    <td className="px-3 py-1.5 tabular-nums">
                      {c.ratio.toFixed(2)} (needs {c.min})
                    </td>
                    <td className="px-3 py-1.5">
                      {c.pass ? (
                        <span className="inline-flex items-center gap-1 text-success">
                          <CheckCircle2 className="h-3 w-3" aria-hidden /> Pass
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-danger">
                          <XCircle className="h-3 w-3" aria-hidden /> Fail
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {saving && (
        <ReasonDialog
          open
          onClose={() => setSaving(false)}
          title="Save the brand theme"
          confirmLabel="Save theme"
          description={<p>Every page picks up the new palette at once. The previous theme is recorded in the audit log.</p>}
          onConfirm={async (reason) => {
            const result = await saveBrandTheme({ theme: theme(), reason });
            if (result.ok) {
              toast(`Theme saved (palette version ${result.data.paletteVersion}).`, "success");
              router.refresh();
            }
            return result;
          }}
        />
      )}
    </div>
  );
}
