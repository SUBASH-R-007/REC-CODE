"use client";

import { useState } from "react";
import { EXAM_BOTTOM_BAR_ACTIONS, ATTEMPT_REVOKE_MESSAGES, type AttemptRevokeReason } from "@recx/shared";

/**
 * The 56px bottom bar (Phase 6c).
 *
 * SPEC §5 fixes the order and will not have it rearranged: "Previous · Mark
 * for review & next · Clear response · Save & next in that order — TCS iON /
 * AMCAT muscle memory, because an exam is the worst possible place to teach
 * new UI."
 *
 * The order is read from `EXAM_BOTTOM_BAR_ACTIONS` in @recx/shared and
 * asserted by a unit test there, so a later tidy-up cannot reorder these for
 * visual balance without the test saying so.
 *
 * "Submit test" is separate and to the right, behind a confirmation, because
 * it is the one irreversible button on the screen and it sits next to three
 * buttons a candidate presses dozens of times.
 */
export function ExamBottomBar({
  canGoPrevious,
  onPrevious,
  onMarkAndNext,
  onClear,
  onSaveAndNext,
  onSubmit,
  answered,
  total,
  status,
  revoked,
}: {
  readonly canGoPrevious: boolean;
  readonly onPrevious: () => void;
  readonly onMarkAndNext: () => void;
  readonly onClear: () => void;
  readonly onSaveAndNext: () => void;
  readonly onSubmit?: () => void;
  readonly answered: number;
  readonly total: number;
  readonly status: string;
  readonly revoked: string | null;
}) {
  const [confirming, setConfirming] = useState(false);
  const over = revoked !== null;

  const handlers: Readonly<Record<string, () => void>> = {
    previous: onPrevious,
    markAndNext: onMarkAndNext,
    clear: onClear,
    saveAndNext: onSaveAndNext,
  };

  if (over) {
    const message =
      ATTEMPT_REVOKE_MESSAGES[revoked as AttemptRevokeReason] ?? "This sitting has ended.";
    return (
      <footer className="flex min-h-14 shrink-0 items-center gap-3 border-t border-border bg-elevated px-4 py-3">
        <p role="status" aria-live="assertive" className="text-sm font-medium text-text">
          {message}
        </p>
        <p className="ml-auto text-xs tabular-nums text-text-secondary">{status}</p>
      </footer>
    );
  }

  return (
    <footer className="flex h-14 shrink-0 items-center gap-2 border-t border-border bg-elevated px-4">
      {EXAM_BOTTOM_BAR_ACTIONS.map((action) => (
        <button
          key={action.id}
          type="button"
          disabled={action.id === "previous" && !canGoPrevious}
          onClick={handlers[action.id]}
          className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-text disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {action.label}
        </button>
      ))}

      <p className="ml-auto text-xs tabular-nums text-text-secondary">
        {answered} of {total} answered
      </p>

      {confirming ? (
        <div className="flex items-center gap-2">
          <p className="text-xs text-text">
            Submit with {total - answered} unanswered?
          </p>
          <button
            type="button"
            onClick={() => {
              setConfirming(false);
              onSubmit?.();
            }}
            className="rounded-md bg-danger px-3 py-1.5 text-sm font-semibold text-background focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Yes, submit
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Keep working
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          Submit test
        </button>
      )}
    </footer>
  );
}
