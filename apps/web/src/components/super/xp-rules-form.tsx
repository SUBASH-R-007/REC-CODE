"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Save } from "lucide-react";
import { Button, Field, Input, useToast } from "@recx/design";
import { updateXpRules } from "@/server/actions/xp-settings";
import { ReasonDialog } from "@/components/super/reason-dialog";

export interface XpRulesValues {
  easy: number;
  medium: number;
  hard: number;
  dailyChallengeMultiplier: number;
  assistedMultiplier: number;
  revisionMultiplier: number;
  easyPerDay: number;
  totalPerDay: number;
}

const FIELDS: ReadonlyArray<{ key: keyof XpRulesValues; label: string; step: string; hint: string }> = [
  { key: "easy", label: "First solve: Easy", step: "1", hint: "0–1,000 XP" },
  { key: "medium", label: "First solve: Medium", step: "1", hint: "0–1,000 XP" },
  { key: "hard", label: "First solve: Hard", step: "1", hint: "0–2,000 XP" },
  { key: "dailyChallengeMultiplier", label: "Daily challenge multiplier", step: "0.05", hint: "1–5" },
  { key: "assistedMultiplier", label: "Assisted solve multiplier", step: "0.05", hint: "0–1" },
  { key: "revisionMultiplier", label: "Revision multiplier", step: "0.05", hint: "0–1" },
  { key: "easyPerDay", label: "Easy XP cap per day", step: "1", hint: "0–10,000" },
  { key: "totalPerDay", label: "Total XP cap per day", step: "1", hint: "0–20,000" },
];

/**
 * The XP rules override (PlatformSetting "xp") through the existing
 * xp-settings#updateXpRules. Each save is a new rules version that later
 * XP events record; earlier events keep theirs.
 */
export function XpRulesForm({ initial }: { initial: XpRulesValues }) {
  const router = useRouter();
  const { toast } = useToast();
  const id = useId();
  const [values, setValues] = useState<Record<keyof XpRulesValues, string>>(
    () =>
      Object.fromEntries(Object.entries(initial).map(([k, v]) => [k, String(v)])) as Record<keyof XpRulesValues, string>,
  );
  const [open, setOpen] = useState(false);
  const num = (key: keyof XpRulesValues) => Number(values[key]);

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        setOpen(true);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {FIELDS.map((f) => (
          <Field key={f.key} label={f.label} htmlFor={`${id}-${f.key}`} hint={f.hint}>
            <Input
              id={`${id}-${f.key}`}
              type="number"
              step={f.step}
              required
              value={values[f.key]}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            />
          </Field>
        ))}
      </div>
      <Button type="submit">
        <Save className="h-4 w-4" aria-hidden />
        Save XP rules
      </Button>
      {open && (
        <ReasonDialog
          open
          onClose={() => setOpen(false)}
          title="Save the XP rules"
          confirmLabel="Save as a new rules version"
          description={<p>Applies to XP earned from now on. Past XP events keep the rules version they were earned under.</p>}
          onConfirm={async (reason) => {
            const result = await updateXpRules({
              rules: {
                firstSolve: { EASY: num("easy"), MEDIUM: num("medium"), HARD: num("hard") },
                dailyChallengeMultiplier: num("dailyChallengeMultiplier"),
                assistedMultiplier: num("assistedMultiplier"),
                revisionMultiplier: num("revisionMultiplier"),
                caps: { easyPerDay: num("easyPerDay"), totalPerDay: num("totalPerDay") },
              },
              reason,
            });
            if (result.ok) {
              toast(`XP rules saved as version ${result.data.version}.`, "success");
              router.refresh();
            }
            return result;
          }}
        />
      )}
    </form>
  );
}
