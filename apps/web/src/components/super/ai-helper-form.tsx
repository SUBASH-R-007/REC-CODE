"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Save } from "lucide-react";
import { Button, Field, Input, Select, useToast } from "@recx/design";
import { AI_DAILY_LIMIT, AI_MODELS, AI_OUTPUT_MAX_TOKENS, type AiHelperSetting } from "@recx/shared";
import { updateAiHelper } from "@/server/actions/super-ai";
import { ReasonDialog } from "@/components/super/reason-dialog";

/**
 * The AI helper's configuration. One form, one save, one audited reason.
 *
 * The on/off switch is a plain select rather than a toggle button because
 * turning it on is not a small act — it starts sending students' draft code
 * to a third party — and it reads back as a sentence the super-admin has to
 * agree with before the reason dialog opens.
 */
export function AiHelperForm({ initial }: { initial: AiHelperSetting }) {
  const router = useRouter();
  const { toast } = useToast();
  const id = useId();
  const [enabled, setEnabled] = useState(initial.enabled ? "on" : "off");
  const [modelId, setModelId] = useState(initial.modelId);
  const [dailyPerStudent, setDailyPerStudent] = useState(String(initial.dailyPerStudent));
  const [maxOutputTokens, setMaxOutputTokens] = useState(String(initial.maxOutputTokens));
  const [open, setOpen] = useState(false);

  const chosen = AI_MODELS.find((m) => m.id === modelId) ?? null;
  const turningOn = enabled === "on" && !initial.enabled;

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

        <Field label="Model" htmlFor={`${id}-model`} hint={chosen?.description ?? "Choose a model."}>
          <Select id={`${id}-model`} value={modelId} onChange={(e) => setModelId(e.target.value)}>
            {AI_MODELS.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </Select>
        </Field>

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

      <Button type="submit">
        <Save className="h-4 w-4" aria-hidden />
        Save
      </Button>

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
                <strong>{chosen?.label ?? modelId}</strong> each time they ask. It answers in practice only, never in a
                contest or an assessment, and a solve that follows an answer counts as assisted.
              </p>
            ) : (
              <p>Takes effect on the next request. Recorded as a security event.</p>
            )
          }
          onConfirm={async (reason) => {
            const result = await updateAiHelper({
              enabled: enabled === "on",
              modelId,
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
