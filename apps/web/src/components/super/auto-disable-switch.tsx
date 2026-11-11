"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Field, Input } from "@recx/design";
import { AUTO_DISABLE_CONFIRMATION, AUTO_DISABLE_FLOOR_DAYS, AUTO_DISABLE_FLOOR_REASON } from "@recx/shared";
import { setAutoDisableEnabled } from "@/server/actions/super-inactivity";

/**
 * The one switch in Phase 8 that can end in a student losing access without a
 * human deciding it (Phase 8b).
 *
 * SPEC §5 is emphatic that this must not be easy, and the design's own rule
 * was "a super-admin about to turn on auto-disable reads the argument against
 * it on the same screen". So the argument is rendered here, above the control,
 * not in a tooltip and not behind a disclosure — and turning it ON requires
 * typing a confirmation, whatever the threshold.
 *
 * Turning it OFF needs nothing at all. Nobody has ever needed to be slowed
 * down on the way to under-enforcing.
 */
export function AutoDisableSwitch({
  version,
  enabled,
  disableAfterDays,
}: {
  version: number;
  enabled: boolean;
  disableAfterDays: number | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const belowFloor = disableAfterDays !== null && disableAfterDays < AUTO_DISABLE_FLOOR_DAYS;

  const change = (next: boolean) => {
    setError(null);
    setDone(null);
    start(async () => {
      const result = await setAutoDisableEnabled({
        version,
        enabled: next,
        confirmation: next ? typed : undefined,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setTyped("");
      setDone(
        next
          ? `Automatic disabling is ON, as version ${result.data.version}. Every super-admin has been emailed.`
          : `Automatic disabling is OFF, as version ${result.data.version}.`,
      );
      router.refresh();
    });
  };

  return (
    <div className="space-y-4">
      {/* The argument, before the control. Deliberately not a disclosure: a
          paragraph somebody has to open is a paragraph nobody reads. */}
      <div className="space-y-3 rounded-xl border border-warning/40 bg-warning-subtle p-4 text-sm">
        <h3 className="font-display text-base font-semibold">Before you turn this on</h3>
        <p>
          With this off, the worst this policy can do to a student is pause their place on the leaderboard and their
          contest entry — and one solved problem undoes it, with nobody&apos;s permission. With it on, an account can be
          closed by a scheduled job at two in the morning while the person it belongs to is asleep, or in hospital, or
          sitting an exam somewhere this platform never heard about.
        </p>
        <p>{AUTO_DISABLE_FLOOR_REASON}</p>
        <p>
          The counter already excludes holidays, exam weeks, placement weeks and approved leave, and it refuses to
          escalate anybody at all while the calendar is incomplete. None of that makes it right about a particular
          student on a particular morning. A human reading a list of names does.
        </p>
        <p className="font-medium">
          The platform works without this. Nothing in the spec, and nothing the placement cell has asked for, needs it.
        </p>
      </div>

      <p className="text-sm">
        Current state for version {version}:{" "}
        <strong>{enabled ? "ON — accounts can be closed automatically" : "OFF — no account is closed automatically"}</strong>
        {disableAfterDays !== null ? (
          <>
            {" "}
            · threshold {disableAfterDays} counted days
            {belowFloor ? (
              <span className="ml-1 text-warning">
                (under the {AUTO_DISABLE_FLOOR_DAYS}-day mark — shorter than most illnesses)
              </span>
            ) : null}
          </>
        ) : (
          " · no threshold set"
        )}
      </p>

      {enabled ? (
        <Button type="button" loading={pending} onClick={() => change(false)}>
          Turn automatic disabling off
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
            label={`Type ${AUTO_DISABLE_CONFIRMATION} to confirm`}
            htmlFor={`confirm-${version}`}
            hint="This is recorded against your name, at SECURITY level, and emailed to every super-admin."
            error={error}
          >
            <Input
              id={`confirm-${version}`}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="max-w-sm font-mono"
            />
          </Field>
          <Button type="submit" variant="secondary" loading={pending} disabled={typed !== AUTO_DISABLE_CONFIRMATION}>
            Turn automatic disabling on
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
