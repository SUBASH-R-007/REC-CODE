"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Save, XCircle, Zap } from "lucide-react";
import { Button, Field, Input, Select, useToast } from "@recx/design";
import {
  AI_DAILY_LIMIT,
  AI_MODEL_ID_MAX,
  AI_MODEL_PRESETS,
  AI_OUTPUT_MAX_TOKENS,
  AI_PROVIDERS,
  AI_PROVIDER_LABEL,
  AI_PROVIDER_NOTE,
  aiModelPreset,
  aiProviderNeedsEndpoint,
  type AiHelperSetting,
  type AiProvider,
} from "@recx/shared";
import { testAiModel, updateAiHelper, type AiModelTestResult } from "@/server/actions/super-ai";
import { ReasonDialog } from "@/components/super/reason-dialog";

/**
 * The AI helper's configuration. One form, one save, one audited reason.
 *
 * The on/off switch is a plain select rather than a toggle button because
 * turning it on is not a small act — it starts sending students' draft code
 * to a third party — and it reads back as a sentence the super-admin has to
 * agree with before the reason dialog opens.
 *
 * The model is theirs to name (Phase 15g): a wire format from the three this
 * build speaks, then any id the provider publishes, with the familiar ones
 * one click away. Two things are not theirs, and the page says so rather
 * than hiding it — the API key, and which hosts may be reached.
 *
 * **Test** is what makes a free-text field kind rather than a trap. It asks
 * the model in the form — not the saved one — one fixed question and reports
 * what came back, so a typo is found here instead of by a student three
 * minutes before they give up on a problem.
 */
export function AiHelperForm({
  initial,
  endpoints,
}: {
  initial: AiHelperSetting;
  /** The addresses AI_BASE_URL allows; a super-admin picks, never types. */
  endpoints: readonly string[];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const id = useId();
  const [enabled, setEnabled] = useState(initial.enabled ? "on" : "off");
  const [provider, setProvider] = useState<AiProvider>(initial.provider);
  const [modelId, setModelId] = useState(initial.modelId);
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  const [dailyPerStudent, setDailyPerStudent] = useState(String(initial.dailyPerStudent));
  const [maxOutputTokens, setMaxOutputTokens] = useState(String(initial.maxOutputTokens));
  const [open, setOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<AiModelTestResult | null>(null);

  const presets = AI_MODEL_PRESETS.filter((p) => p.provider === provider);
  const chosen = aiModelPreset(provider, modelId);
  const needsEndpoint = aiProviderNeedsEndpoint(provider);
  const turningOn = enabled === "on" && !initial.enabled;
  const label = chosen?.label ?? modelId;

  function changeProvider(next: AiProvider) {
    setProvider(next);
    setTested(null);
    // A model id belongs to its provider: carrying one across is how a
    // Claude id ends up being sent to OpenAI. The preset for the new
    // provider, if it has one, or an empty field to type into.
    setModelId(AI_MODEL_PRESETS.find((p) => p.provider === next)?.modelId ?? "");
    if (!aiProviderNeedsEndpoint(next)) setBaseUrl("");
  }

  async function test() {
    setTesting(true);
    const result = await testAiModel({ provider, modelId, baseUrl });
    setTesting(false);
    if (!result.ok) {
      toast(result.error, "error");
      return;
    }
    setTested(result.data);
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        setOpen(true);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="The assistant"
          htmlFor={`${id}-enabled`}
          hint="Off means no student can ask, whatever else is set here."
        >
          <Select id={`${id}-enabled`} value={enabled} onChange={(e) => setEnabled(e.target.value)}>
            <option value="off">Off — nobody can ask</option>
            <option value="on">On — students may ask in practice</option>
          </Select>
        </Field>

        <Field label="Provider" htmlFor={`${id}-provider`} hint={AI_PROVIDER_NOTE[provider]}>
          <Select
            id={`${id}-provider`}
            value={provider}
            onChange={(e) => changeProvider(e.target.value as AiProvider)}
          >
            {AI_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {AI_PROVIDER_LABEL[p]}
              </option>
            ))}
          </Select>
        </Field>

        {presets.length > 0 && (
          <Field
            label="A familiar model"
            htmlFor={`${id}-preset`}
            hint={chosen?.description ?? "Or type any id below."}
          >
            <Select
              id={`${id}-preset`}
              value={chosen?.modelId ?? ""}
              onChange={(e) => {
                setModelId(e.target.value);
                setTested(null);
              }}
            >
              <option value="">Something else — typed below</option>
              {presets.map((p) => (
                <option key={p.modelId} value={p.modelId}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <Field
          label="Model id"
          htmlFor={`${id}-model`}
          hint={
            needsEndpoint
              ? "As your endpoint names it. Leave it empty to use the model the deployment sets in AI_MODEL."
              : "As the provider publishes it."
          }
        >
          <Input
            id={`${id}-model`}
            value={modelId}
            maxLength={AI_MODEL_ID_MAX}
            spellCheck={false}
            autoComplete="off"
            placeholder={needsEndpoint ? "qwen2.5-coder:32b" : "claude-sonnet-5-5"}
            onChange={(e) => {
              setModelId(e.target.value);
              setTested(null);
            }}
          />
        </Field>

        {needsEndpoint && (
          <Field
            label="Endpoint"
            htmlFor={`${id}-endpoint`}
            hint={
              endpoints.length > 0
                ? "The addresses this deployment allows (AI_BASE_URL). Not typed here: it is where the key goes."
                : "This deployment sets no usable AI_BASE_URL, so there is nothing to reach."
            }
          >
            <Select
              id={`${id}-endpoint`}
              value={baseUrl}
              disabled={endpoints.length === 0}
              onChange={(e) => {
                setBaseUrl(e.target.value);
                setTested(null);
              }}
            >
              <option value="">{endpoints[0] ? `${endpoints[0]} (the first)` : "none configured"}</option>
              {endpoints.map((url) => (
                <option key={url} value={url}>
                  {url}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <Field
          label="Questions per student per day"
          htmlFor={`${id}-daily`}
          hint={`${AI_DAILY_LIMIT.min}–${AI_DAILY_LIMIT.max}. The allowance resets at midnight IST.`}
        >
          <Input
            id={`${id}-daily`}
            type="number"
            min={AI_DAILY_LIMIT.min}
            max={AI_DAILY_LIMIT.max}
            step="1"
            required
            value={dailyPerStudent}
            onChange={(e) => setDailyPerStudent(e.target.value)}
          />
        </Field>

        <Field
          label="Longest answer (tokens)"
          htmlFor={`${id}-tokens`}
          hint={`${AI_OUTPUT_MAX_TOKENS.min}–${AI_OUTPUT_MAX_TOKENS.max}. Shorter answers cost less and teach better.`}
        >
          <Input
            id={`${id}-tokens`}
            type="number"
            min={AI_OUTPUT_MAX_TOKENS.min}
            max={AI_OUTPUT_MAX_TOKENS.max}
            step="1"
            required
            value={maxOutputTokens}
            onChange={(e) => setMaxOutputTokens(e.target.value)}
          />
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit">
          <Save className="h-4 w-4" aria-hidden />
          Save
        </Button>
        <Button type="button" variant="outline" loading={testing} onClick={test}>
          <Zap className="h-4 w-4" aria-hidden />
          Test this model
        </Button>
      </div>

      <p aria-live="polite" className="text-sm">
        {tested === null ? (
          <span className="text-text-secondary">
            Testing asks the model one fixed question. No student&apos;s work is sent, and nothing is saved.
          </span>
        ) : tested.reachable ? (
          <span className="flex flex-wrap items-baseline gap-x-2 text-text">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-hidden />
            <span>
              <strong>{tested.label}</strong> answered in {tested.latencyMs} ms
              {tested.tokensOut === null ? "" : ` (${tested.tokensOut} tokens out)`}:
            </span>
            <span className="w-full text-text-secondary">{tested.reply}</span>
          </span>
        ) : (
          <span className="flex flex-wrap items-baseline gap-x-2 text-text">
            <XCircle className="h-4 w-4 shrink-0 text-danger" aria-hidden />
            <span>
              <strong>{tested.label}</strong> did not answer: {tested.problem}.
            </span>
          </span>
        )}
      </p>

      {open && (
        <ReasonDialog
          open
          onClose={() => setOpen(false)}
          title="Save the assistant's settings"
          confirmLabel="Save"
          danger={turningOn}
          description={
            turningOn ? (
              <p>
                Turning the assistant on sends a student&apos;s problem statement and their own draft code to{" "}
                <strong>{label || AI_PROVIDER_LABEL[provider]}</strong> each time they ask. It answers in practice
                only, never in a contest or an assessment, and a solve that follows an answer counts as assisted.
              </p>
            ) : (
              <p>Takes effect on the next request. Recorded as a security event.</p>
            )
          }
          onConfirm={async (reason) => {
            const result = await updateAiHelper({
              enabled: enabled === "on",
              provider,
              modelId,
              baseUrl,
              dailyPerStudent: Number(dailyPerStudent),
              maxOutputTokens: Number(maxOutputTokens),
              reason,
            });
            if (result.ok) {
              toast(`The assistant is ${result.data.enabled ? "on" : "off"}.`, "success");
              router.refresh();
            }
            return result;
          }}
        />
      )}
    </form>
  );
}
