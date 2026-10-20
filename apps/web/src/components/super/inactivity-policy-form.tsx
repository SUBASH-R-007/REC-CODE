"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Field, Input } from "@recx/design";
import {
  ACTIVITY_SIGNAL_SOURCES,
  AUTO_DISABLE_CONFIRMATION,
  DEFAULT_INACTIVITY_POLICY,
  type ActivitySignal,
  type InactivityPolicyShape,
} from "@recx/shared";
import { activateInactivityPolicy, saveInactivityPolicy } from "@/server/actions/super-inactivity";

/**
 * Drafting a policy version (Phase 8b).
 *
 * Saving and activating are separate buttons on purpose: a half-considered
 * edit must not start restricting a cohort the moment it is saved. And the
 * form never edits a version in place, because the row is immutable — a
 * change is a new version, and the version history is the audit trail of the
 * thresholds.
 *
 * The two activity signals with no source in this database are rendered as
 * disabled controls with the reason beside them rather than hidden. A toggle
 * that silently does nothing is worse than one that says so.
 */

const SIGNAL_LABEL: Record<ActivitySignal, string> = {
  submission: "A judged submission",
  solve: "A problem solved",
  login: "Signing in",
  lesson: "An LMS lesson",
};

const SIGNAL_UNAVAILABLE: Partial<Record<ActivitySignal, string>> = {
  login: "No effect: there is no login column to read, and a policy counting logins teaches a daily one-minute login.",
  lesson: "No effect: lessons live in the LMS, which REC Code does not read.",
};

type Draft = Omit<InactivityPolicyShape, "version" | "isActive" | "notifyParentEmail">;

const numberOrNull = (value: string): number | null => (value.trim() === "" ? null : Number(value));

export function InactivityPolicyForm({ seed }: { seed?: InactivityPolicyShape }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [draft, setDraft] = useState<Draft>(() => ({
    batchYear: seed?.batchYear ?? null,
    departmentCode: seed?.departmentCode ?? null,
    nudgeAfterDays: seed?.nudgeAfterDays ?? DEFAULT_INACTIVITY_POLICY.nudgeAfterDays,
    warnAfterDays: seed?.warnAfterDays ?? DEFAULT_INACTIVITY_POLICY.warnAfterDays,
    softRestrictAfterDays: seed?.softRestrictAfterDays ?? DEFAULT_INACTIVITY_POLICY.softRestrictAfterDays,
    disableAfterDays: seed?.disableAfterDays ?? DEFAULT_INACTIVITY_POLICY.disableAfterDays,
    autoDisableEnabled: false,
    graceDays: seed?.graceDays ?? DEFAULT_INACTIVITY_POLICY.graceDays,
    countsAsActivity: seed?.countsAsActivity ?? DEFAULT_INACTIVITY_POLICY.countsAsActivity,
    minActivityPerDay: seed?.minActivityPerDay ?? DEFAULT_INACTIVITY_POLICY.minActivityPerDay,
    excludeNonWorkingDays: seed?.excludeNonWorkingDays ?? DEFAULT_INACTIVITY_POLICY.excludeNonWorkingDays,
    excludeApprovedLeave: seed?.excludeApprovedLeave ?? DEFAULT_INACTIVITY_POLICY.excludeApprovedLeave,
    notifyMentor: seed?.notifyMentor ?? DEFAULT_INACTIVITY_POLICY.notifyMentor,
  }));
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(null);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((all) => ({ ...all, [key]: value }));

  const save = () => {
    setError(null);
    setSaved(null);
    start(async () => {
      const result = await saveInactivityPolicy({
        policy: { ...draft, isActive: false, notifyParentEmail: false },
        confirmation: confirmation.trim() === "" ? undefined : confirmation.trim(),
      });
      if (!result.ok) setError(result.error);
      else {
        setSaved(result.data.version);
        router.refresh();
      }
    });
  };

  const activate = (version: number) => {
    setError(null);
    start(async () => {
      const result = await activateInactivityPolicy({ version });
      if (!result.ok) setError(result.error);
      else router.refresh();
    });
  };

  const threshold = (
    key: "nudgeAfterDays" | "warnAfterDays" | "softRestrictAfterDays" | "disableAfterDays",
    label: string,
    hint: string,
  ) => (
    <Field label={label} htmlFor={`pol-${key}`} hint={hint}>
      <Input
        id={`pol-${key}`}
        type="number"
        min={1}
        max={365}
        value={draft[key] ?? ""}
        placeholder="never"
        onChange={(event) => set(key, numberOrNull(event.target.value))}
        className="max-w-28"
      />
    </Field>
  );

  return (
    <form
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <fieldset className="space-y-4">
        <legend className="font-display text-base font-semibold">Who it applies to</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Batch year" htmlFor="pol-batch" hint="Leave empty for every batch.">
            <Input
              id="pol-batch"
              type="number"
              min={2000}
              max={2100}
              value={draft.batchYear ?? ""}
              placeholder="every batch"
              onChange={(event) => set("batchYear", numberOrNull(event.target.value))}
              className="max-w-32"
            />
          </Field>
          <Field label="Department code" htmlFor="pol-dept" hint="Leave empty for every department.">
            <Input
              id="pol-dept"
              value={draft.departmentCode ?? ""}
              placeholder="every department"
              maxLength={16}
              onChange={(event) =>
                set("departmentCode", event.target.value.trim() === "" ? null : event.target.value.trim())
              }
              className="max-w-32"
            />
          </Field>
        </div>
        <p className="text-xs text-muted">
          The most specific policy wins: department and batch, then batch, then department, then the global one. One
          live version per scope.
        </p>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="font-display text-base font-semibold">The ladder</legend>
        <p className="text-sm text-text-secondary">
          Counted days of inactivity, not calendar days. Leave a box empty and that rung never fires.
        </p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {threshold("nudgeAfterDays", "Nudge after", "A message to the student. No consequence.")}
          {threshold("warnAfterDays", "Warn after", "The student and their mentor are told.")}
          {threshold(
            "softRestrictAfterDays",
            "Pause after",
            "Off the public leaderboard, no contest entry, no new XP on the boards. Signing in, reading and solving all still work.",
          )}
          {threshold(
            "disableAfterDays",
            "Close after",
            "Only ever reached if automatic disabling is switched on below, which it is not by default.",
          )}
        </div>
        <Field
          label="Grace days"
          htmlFor="pol-grace"
          hint="How long to wait after telling a student before acting on the next rung."
        >
          <Input
            id="pol-grace"
            type="number"
            min={0}
            max={30}
            value={draft.graceDays}
            onChange={(event) => set("graceDays", Number(event.target.value))}
            className="max-w-28"
          />
        </Field>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="font-display text-base font-semibold">What counts as activity</legend>
        <ul className="space-y-3">
          {(Object.keys(SIGNAL_LABEL) as ActivitySignal[]).map((signal) => {
            const unavailable = ACTIVITY_SIGNAL_SOURCES[signal] === null;
            return (
              <li key={signal}>
                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.countsAsActivity[signal]}
                    disabled={unavailable}
                    aria-describedby={unavailable ? `sig-${signal}-hint` : undefined}
                    onChange={(event) =>
                      set("countsAsActivity", { ...draft.countsAsActivity, [signal]: event.target.checked })
                    }
                  />
                  <span className={unavailable ? "text-muted" : undefined}>{SIGNAL_LABEL[signal]}</span>
                </label>
                {unavailable ? (
                  <p id={`sig-${signal}-hint`} className="ml-6 text-xs text-muted">
                    {SIGNAL_UNAVAILABLE[signal]}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
        <Field
          label="Activity a day needs to count as active"
          htmlFor="pol-min"
          hint="The submissions and solves of that day, added together."
        >
          <Input
            id="pol-min"
            type="number"
            min={1}
            max={20}
            value={draft.minActivityPerDay}
            onChange={(event) => set("minActivityPerDay", Number(event.target.value))}
            className="max-w-28"
          />
        </Field>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="font-display text-base font-semibold">Which days are not counted</legend>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.excludeNonWorkingDays}
            onChange={(event) => set("excludeNonWorkingDays", event.target.checked)}
          />
          <span>Skip non-working days (Sundays and declared closures)</span>
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.excludeApprovedLeave}
            onChange={(event) => set("excludeApprovedLeave", event.target.checked)}
          />
          <span>Skip days covered by approved leave</span>
        </label>
        <p className="text-xs text-muted">
          Holidays, exam weeks, semester breaks and placement weeks are never counted, whatever these say — that is
          structural, not a preference.
        </p>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.notifyMentor}
            onChange={(event) => set("notifyMentor", event.target.checked)}
          />
          <span>Tell the student&apos;s mentor at the warning rung</span>
        </label>
      </fieldset>

      <Field
        label="Confirmation (only needed for a short automatic-disable threshold)"
        htmlFor="pol-confirm"
        hint={`Type ${AUTO_DISABLE_CONFIRMATION} if you are setting a close-after under a fortnight.`}
        error={error}
      >
        <Input
          id="pol-confirm"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          autoComplete="off"
          className="max-w-sm font-mono"
        />
      </Field>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={pending}>
          Save as a new version
        </Button>
        {saved !== null ? (
          <>
            <p role="status" className="text-sm text-success">
              Saved as version {saved}, not yet live.
            </p>
            <Button type="button" variant="secondary" loading={pending} onClick={() => activate(saved)}>
              Make version {saved} live
            </Button>
          </>
        ) : null}
      </div>

      <p className="text-xs text-muted">
        Saving never changes a version that already exists — every version is kept, because the decisions taken under it
        cite it by number. Automatic disabling is off in anything saved here; it has its own switch below.
      </p>

      <noscript>
        <p className="rounded-md border border-border p-3 text-sm">
          This form needs JavaScript. The thresholds can also be written straight to the database, but doing it that way
          writes no audit row and the version it creates would cite no author — so please use this page.
        </p>
      </noscript>
    </form>
  );
}
