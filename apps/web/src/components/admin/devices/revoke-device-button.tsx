"use client";

import { useState, useTransition } from "react";
import { revokeExamDevice } from "@/server/actions/exam-devices";

/**
 * Withdraw one exam device (Phase 6d).
 *
 * The reason box is not optional and is not a nicety: SPEC §5 makes
 * rebinding "an audited Admin action", and every staff action in this system
 * carries a written reason the student may ask to see. So the button opens the
 * box rather than doing the thing — a one-click withdrawal would be a
 * one-click way to stop someone sitting an exam.
 */
export function RevokeDeviceButton({
  deviceId,
  label,
}: {
  readonly deviceId: string;
  readonly label: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-border px-2 py-1 text-xs font-medium text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        Withdraw
      </button>
    );
  }

  return (
    <form
      className="flex w-full flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        start(async () => {
          const result = await revokeExamDevice({ deviceId, reason });
          if (result.ok) {
            setOpen(false);
            setReason("");
            return;
          }
          setError(result.error);
        });
      }}
    >
      <label className="min-w-0 flex-1 text-xs font-medium text-text">
        Why are you withdrawing &ldquo;{label}&rdquo;? This is recorded.
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          minLength={10}
          maxLength={500}
          required
          placeholder="Student reported the key lost on 19 Oct"
          className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1 text-xs text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-danger px-3 py-1.5 text-xs font-semibold text-background disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {pending ? "Withdrawing…" : "Withdraw"}
      </button>
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          setError(null);
        }}
        className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        Cancel
      </button>
      {error ? (
        <p role="alert" className="w-full text-xs text-danger">
          {error}
        </p>
      ) : null}
    </form>
  );
}
