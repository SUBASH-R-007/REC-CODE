"use client";

import { useState, useTransition } from "react";
import { decideAppeal, recordVerdict } from "@/server/actions/integrity";

/**
 * Recording a verdict, or deciding an appeal (Phase 6e).
 *
 * SPEC §5: "mandatory human verdict with a written rationale". So there is no
 * way to submit this form without writing one — the textarea is required, the
 * action's schema floors it at 40 characters, and a CHECK in the database
 * floors it again. Three layers for one rule, because the rule is the whole
 * point: a student reads this sentence, and "ok" is not a reason to withhold
 * somebody's result.
 *
 * "Clear" is the primary button. That is deliberate. SPEC §0 caps what the
 * system may do automatically and this screen is where a human either lifts
 * that or confirms it; making "uphold" the easy click would quietly invert
 * the posture the whole phase is built on.
 */
export function VerdictForm({
  flagId,
  appealId,
  reviewersRequired,
  reviewsRecorded,
}: {
  readonly flagId: string;
  /** Set when this form is deciding an APPEAL rather than the flag itself. */
  readonly appealId?: string;
  readonly reviewersRequired: number;
  readonly reviewsRecorded: number;
}) {
  const [rationale, setRationale] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = (verdict: "CLEAR" | "UPHOLD") => {
    setError(null);
    setDone(null);
    start(async () => {
      const result = appealId
        ? await decideAppeal({ appealId, verdict, rationale })
        : await recordVerdict({ flagId, verdict, rationale });
      if (result.ok) {
        setRationale("");
        setDone(
          result.data.resolved
            ? appealId
              ? "Appeal decided."
              : "Decided. The result is no longer withheld pending review."
            : "Recorded. This needs another independent reviewer.",
        );
        return;
      }
      setError(result.error);
    });
  };

  if (done) {
    return (
      <p role="status" className="rounded-md border border-success/40 bg-success-subtle px-3 py-2 text-sm text-success">
        {done}
      </p>
    );
  }

  return (
    <form className="rounded-xl border border-border bg-surface p-4" onSubmit={(event) => event.preventDefault()}>
      <h2 className="font-display text-base font-semibold text-text">
        {appealId ? "Decide this appeal" : "Your verdict"}
      </h2>
      <p className="mt-1 text-xs text-text-secondary">
        {appealId
          ? "Two people who did not review the original flag decide an appeal. If either of you clears it, it is overturned."
          : reviewersRequired > 1
            ? `This band needs ${reviewersRequired} independent reviewers; ${reviewsRecorded} so far. If any of you clears it, it is cleared.`
            : "Write what you concluded and why. The student reads this."}
      </p>

      <label className="mt-3 block text-sm font-medium text-text">
        What you concluded, and why
        <textarea
          value={rationale}
          onChange={(event) => setRationale(event.target.value)}
          minLength={40}
          maxLength={4_000}
          required
          rows={4}
          placeholder="The snapshot timeline grows steadily over fifty minutes with failed runs in between; the single paste was 60 characters of sample input."
          className="mt-1 w-full rounded-md border border-border bg-surface p-2 text-sm text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        />
        <span className="mt-1 block text-xs text-text-secondary tabular-nums">
          {rationale.trim().length} characters — at least 40, and the student will read it.
        </span>
      </label>

      <div className="mt-3 flex flex-wrap gap-3">
        {/* Primary: see the module comment. */}
        <button
          type="button"
          disabled={pending || rationale.trim().length < 40}
          onClick={() => submit("CLEAR")}
          className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-fg disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {pending ? "Recording…" : "Clear — publish this result"}
        </button>
        <button
          type="button"
          disabled={pending || rationale.trim().length < 40}
          onClick={() => submit("UPHOLD")}
          className="rounded-md border border-danger/40 px-4 py-2 text-sm font-semibold text-danger disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          Uphold — keep it withheld
        </button>
      </div>

      {error ? (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </form>
  );
}
