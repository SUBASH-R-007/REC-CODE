"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button, Field, Input } from "@recx/design";
import { ENFORCE_CONFIRMATION, ENFORCE_REASON } from "@recx/shared";
import { setEnforceEnabled } from "@/server/actions/super-inactivity";

/**
 * The switch between watching and acting (Phase 12w).
 *
 * Phase 8 shipped the engine with a dry run, as SPEC §5 asks. The manual
 * gate — a human reading a real report before the job goes near a roster —
 * was read on 2026-11-01, and the answer was "keep it reporting". There was
 * no way to say that: the only lever was the scheduler's `--dry-run`, which
 * belongs to the whole process and would also have stopped papers
 * auto-submitting at their deadline. This is that answer, as a property of
 * the policy.
 *
 * Off is not a degraded state. A college can run the engine for a term in
 * report-only, read what it would have done to whom, and decide. That is the
 * order the spec's own title asks for — a policy engine, not a kill switch.
 */
export function EnforceSwitch({
  version,
  enabled,
  autoDisableEnabled,
  disableAfterDays,
}: {
  version: number;
  enabled: boolean;
  autoDisableEnabled: boolean;
  disableAfterDays: number | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  /** The pair that can CLOSE an account rather than pause one. */
  const canClose = autoDisableEnabled && disableAfterDays !== null;

  const change = (next: boolean) => {
    setError(null);
    setDone(null);
    start(async () => {
      const result = await setEnforceEnabled({ version, enabled: next, confirmation: next ? typed : undefined });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setTyped("");
      setDone(
        next
          ? `Enforcement is ON, as version ${result.data.version}. The sweep will act at 02:00. Every super-admin has been emailed.`
          : `Enforcement is OFF, as version ${result.data.version}. The sweep will keep reporting and will write nothing. Restrictions already in place are unchanged — lift those on the inactivity review page.`,
      );
      router.refresh();
    });
  };

  return (
    <div className="space-y-4">
      {/* The argument, before the control — the same rule as the
          auto-disable switch: a paragraph behind a disclosure is a
          paragraph nobody reads. */}
      <div className="space-y-3 rounded-xl border border-warning/40 bg-warning-subtle p-4 text-sm">
        <h3 className="font-display text-base font-semibold">Before you turn this on</h3>
        <p>{ENFORCE_REASON}</p>
        <p>
          The report is on the{" "}
          <Link href="/super/jobs" className="underline">
            scheduled jobs page
          </Link>
          , under <code className="font-mono text-xs">inactivitySweep</code>: how many students were considered, how
          many would move, how many were held back and why. Read a few nights of it before deciding. The figures a
          report-only run produces are the figures a live run would act on — it is the same code path, which is the only
          reason a report is worth having.
        </p>
        {canClose ? (
          <p className="font-medium text-danger">
            Automatic disabling is also on for this version, with a {disableAfterDays}-day threshold. Turning
            enforcement on therefore lets the job <strong>close</strong> accounts, not only pause them. If that is not
            what you meant, turn automatic disabling off first.
          </p>
        ) : (
          <p>
            Automatic disabling is off for this version, so the worst this policy can do once enforcing is pause a
            student&apos;s place on the leaderboard and their contest entry — and one solved problem undoes it, with
            nobody&apos;s permission.
          </p>
        )}
      </div>

      <p className="text-sm">
        Current state for version {version}:{" "}
        <strong>
          {enabled
            ? "ON — the nightly job acts on this policy"
            : "OFF — the nightly job reports on this policy and writes nothing"}
        </strong>
      </p>

      {enabled ? (
        <Button type="button" loading={pending} onClick={() => change(false)}>
          Go back to reporting only
        </Button>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            change(true);
          }}
        >
          <Field
            label={`Type ${ENFORCE_CONFIRMATION} to confirm`}
            htmlFor={`enforce-${version}`}
            hint="This is recorded against your name, at SECURITY level, and emailed to every super-admin."
            error={error}
          >
            <Input
              id={`enforce-${version}`}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="max-w-sm font-mono"
            />
          </Field>
          <Button type="submit" variant="secondary" loading={pending} disabled={typed !== ENFORCE_CONFIRMATION}>
            Let the job act on this policy
          </Button>
        </form>
      )}

      {enabled && error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {done ? (
        <p role="status" className="text-sm text-success">
          {done}
        </p>
      ) : null}
    </div>
  );
}
