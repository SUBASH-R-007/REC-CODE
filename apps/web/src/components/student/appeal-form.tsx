"use client";

import { useState, useTransition } from "react";
import { submitAppeal } from "@/server/actions/appeals";

/**
 * A student's appeal, in their own words (Phase 6e).
 *
 * The words are stored exactly as written and never summarised: they ARE the
 * appeal, and two people who did not make the original decision read them.
 *
 * There is no file upload, no category dropdown and no form to fill in
 * correctly. A student appealing a withheld result is already having a bad
 * week, and the only thing this screen asks of them is a sentence.
 */
export function AppealForm({ flagId }: { readonly flagId: string }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<Date | null>(null);
  const [pending, start] = useTransition();

  if (sent) {
    return (
      <p role="status" className="rounded-md border border-success/40 bg-success-subtle px-3 py-2 text-sm text-success">
        Your appeal is in. Two people who did not make the original decision will read it, and you will see their
        reasons here. If nobody decides it by then, it resolves in your favour.
      </p>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        start(async () => {
          const result = await submitAppeal({ flagId, reason });
          if (result.ok) {
            setSent(result.data.decideBy);
            return;
          }
          setError(result.error);
        });
      }}
    >
      <label className="block text-sm font-medium text-text">
        Why you think this is wrong
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          minLength={20}
          maxLength={4_000}
          required
          rows={5}
          placeholder="I wrote this myself. The paste was the sample input from the question, and I lost focus because my laptop kept dropping the hostel wifi."
          className="mt-1 w-full rounded-md border border-border bg-surface p-2 text-sm text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        />
      </label>
      <button
        type="submit"
        disabled={pending || reason.trim().length < 20}
        className="mt-3 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-fg disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {pending ? "Sending…" : "Send my appeal"}
      </button>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </form>
  );
}
