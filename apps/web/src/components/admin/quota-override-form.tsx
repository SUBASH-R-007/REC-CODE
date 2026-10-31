"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { UserCog } from "lucide-react";
import { Button, Field, Input, Textarea, useToast } from "@recx/design";
import { grantJudgeQuotaOverride } from "@/server/actions/admin-judge";

interface FormState {
  collegeId: string;
  practicePerDay: string;
  runsPerHour: string;
  cpuMinutesPerDay: string;
  expiresAt: string;
  reason: string;
}

const EMPTY: FormState = {
  collegeId: "",
  practicePerDay: "",
  runsPerHour: "",
  cpuMinutesPerDay: "",
  expiresAt: "",
  reason: "",
};

/**
 * Grant one student a JudgeQuotaOverride (SUPER_ADMIN; audited). Empty cap
 * fields keep the default; the newest active override replaces older ones;
 * an override with every cap empty puts the student back on the defaults.
 */
export function QuotaOverrideForm({
  defaults,
}: {
  defaults: { practicePerDay: number; runsPerHour: number; cpuMinutesPerDay: number };
}) {
  const id = useId();
  const router = useRouter();
  const { toast } = useToast();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const set = (key: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <form
      className="space-y-4"
      aria-describedby={`${id}-about`}
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        startTransition(async () => {
          const result = await grantJudgeQuotaOverride({
            collegeId: form.collegeId,
            practicePerDay: form.practicePerDay,
            runsPerHour: form.runsPerHour,
            cpuMinutesPerDay: form.cpuMinutesPerDay,
            expiresAt: form.expiresAt,
            reason: form.reason,
          });
          if (!result.ok) {
            setError(result.error);
            return;
          }
          toast(`Judge caps updated for ${result.data.collegeId}.`, "success");
          setForm(EMPTY);
          router.refresh();
        });
      }}
    >
      <p id={`${id}-about`} className="text-sm text-text-secondary">
        Leave a cap empty to keep the default. The newest active override for a student replaces any older one; saving
        with every cap empty puts the student back on the defaults.
      </p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Roll number" htmlFor={`${id}-college`}>
          <Input
            id={`${id}-college`}
            value={form.collegeId}
            onChange={set("collegeId")}
            autoComplete="off"
            spellCheck={false}
            required
            maxLength={64}
            className="font-mono"
          />
        </Field>
        <Field label="Practice submissions per day" htmlFor={`${id}-practice`} hint={`Default ${defaults.practicePerDay}`}>
          <Input
            id={`${id}-practice`}
            type="number"
            inputMode="numeric"
            min={1}
            max={10_000}
            step={1}
            value={form.practicePerDay}
            onChange={set("practicePerDay")}
            placeholder={String(defaults.practicePerDay)}
            className="tabular-nums"
          />
        </Field>
        <Field label="Runs per hour" htmlFor={`${id}-runs`} hint={`Default ${defaults.runsPerHour}`}>
          <Input
            id={`${id}-runs`}
            type="number"
            inputMode="numeric"
            min={1}
            max={1_000}
            step={1}
            value={form.runsPerHour}
            onChange={set("runsPerHour")}
            placeholder={String(defaults.runsPerHour)}
            className="tabular-nums"
          />
        </Field>
        <Field label="CPU-minutes per day" htmlFor={`${id}-cpu`} hint={`Default ${defaults.cpuMinutesPerDay}`}>
          <Input
            id={`${id}-cpu`}
            type="number"
            inputMode="numeric"
            min={1}
            max={600}
            step={1}
            value={form.cpuMinutesPerDay}
            onChange={set("cpuMinutesPerDay")}
            placeholder={String(defaults.cpuMinutesPerDay)}
            className="tabular-nums"
          />
        </Field>
        <Field label="Expires (IST, optional)" htmlFor={`${id}-expires`} hint="Empty = until replaced.">
          <Input
            id={`${id}-expires`}
            type="datetime-local"
            value={form.expiresAt}
            onChange={set("expiresAt")}
            className="tabular-nums"
          />
        </Field>
      </div>
      <Field label="Reason" htmlFor={`${id}-reason`} hint="Recorded in the audit log with your name." error={error}>
        <Textarea
          id={`${id}-reason`}
          value={form.reason}
          onChange={set("reason")}
          rows={2}
          required
          minLength={5}
          maxLength={500}
        />
      </Field>
      <div className="flex justify-end">
        <Button type="submit" loading={pending}>
          {!pending && <UserCog className="h-4 w-4" aria-hidden />}
          Save override
        </Button>
      </div>
    </form>
  );
}
