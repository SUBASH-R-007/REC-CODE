"use client";

import { useState, useTransition } from "react";
import {
  confirmTermination,
  grantExtraTime,
  messageCandidate,
  recordObservation,
  requestTermination,
} from "@/server/actions/invigilate";

/**
 * What an invigilator can do to one candidate (Phase 6e).
 *
 * SPEC §5: every one of these "requires a free-text reason and writes an
 * AuditLog row". So none of them is a one-click button: each opens a form
 * with a reason box, and the reason box is required by the action's own
 * schema, not only by this component.
 *
 * Terminate is two buttons apart from the rest, in the danger tone, and says
 * in its own copy that it does NOT void the result — because that is the
 * thing an invigilator most needs to know before pressing it, and the thing a
 * student most needs to be true.
 */

type Open = "none" | "message" | "time" | "observe" | "terminate" | "confirm";

export function CandidateActions({
  attemptId,
  name,
  live,
  terminationPending,
}: {
  readonly attemptId: string;
  readonly name: string;
  readonly live: boolean;
  readonly terminationPending: boolean;
}) {
  const [open, setOpen] = useState<Open>("none");
  const [text, setText] = useState("");
  const [minutes, setMinutes] = useState(10);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const close = () => {
    setOpen("none");
    setText("");
    setError(null);
  };

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, success: string) => {
    setError(null);
    setDone(null);
    start(async () => {
      const result = await fn();
      if (result.ok) {
        setDone(success);
        close();
        return;
      }
      setError(result.error ?? "That did not work.");
    });
  };

  if (!live && !terminationPending) {
    return done ? <p className="text-xs text-success">{done}</p> : null;
  }

  if (open === "none") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {live ? (
          <>
            <Small onClick={() => setOpen("message")}>Message</Small>
            <Small onClick={() => setOpen("time")}>Grant time</Small>
            <Small onClick={() => setOpen("observe")}>Record what you saw</Small>
            {!terminationPending ? (
              <Small onClick={() => setOpen("terminate")} danger>
                Terminate
              </Small>
            ) : null}
          </>
        ) : null}
        {terminationPending ? (
          <Small onClick={() => setOpen("confirm")} danger>
            Confirm termination
          </Small>
        ) : null}
        {done ? <span className="text-xs text-success">{done}</span> : null}
      </div>
    );
  }

  return (
    <form
      className="w-full"
      onSubmit={(event) => {
        event.preventDefault();
        if (open === "message") {
          run(() => messageCandidate({ attemptId, body: text, requiresAck: true }), "Message sent.");
        } else if (open === "time") {
          run(
            () => grantExtraTime({ attemptId, minutes, reason: text }),
            `${minutes} minutes granted.`,
          );
        } else if (open === "observe") {
          run(() => recordObservation({ attemptId, note: text }), "Observation recorded.");
        } else if (open === "terminate") {
          run(
            () => requestTermination({ attemptId, reason: text }),
            "Asked to terminate. A second staff member must confirm.",
          );
        } else {
          run(() => confirmTermination({ attemptId, reason: text }), "Sitting ended.");
        }
      }}
    >
      <p className="text-xs font-medium text-text">
        {open === "message"
          ? `Message ${name} — they must acknowledge it before continuing.`
          : open === "time"
            ? `Grant ${name} extra minutes. Say why; this is recorded.`
            : open === "observe"
              ? `What did you see? It goes on ${name}'s record for the reviewer, as context — it cannot flag them by itself, and ${name} never sees it.`
              : open === "terminate"
                ? `Ask to end ${name}'s sitting. A second staff member must confirm, and this does NOT void their result — the work stands and a human decides what it means.`
                : `Confirm ending ${name}'s sitting, as the second staff member. This does NOT void their result.`}
      </p>

      <div className="mt-2 flex flex-wrap items-end gap-2">
        {open === "time" ? (
          <label className="text-xs font-medium text-text">
            Minutes
            <input
              type="number"
              min={1}
              max={120}
              value={minutes}
              onChange={(event) => setMinutes(Number(event.target.value))}
              className="mt-1 block w-20 rounded-md border border-border bg-surface px-2 py-1 text-xs text-text tabular-nums focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            />
          </label>
        ) : null}

        <label className="min-w-0 flex-1 text-xs font-medium text-text">
          {open === "message" ? "What to say" : "Why"}
          <input
            value={text}
            onChange={(event) => setText(event.target.value)}
            minLength={open === "message" ? 1 : 20}
            maxLength={2_000}
            required
            placeholder={
              open === "message" ? "Please raise your hand." : "Candidate's machine lost power for eight minutes."
            }
            className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1 text-xs text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
        </label>

        <button
          type="submit"
          disabled={pending}
          className={`rounded-md px-3 py-1.5 text-xs font-semibold disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
            open === "terminate" || open === "confirm"
              ? "bg-danger text-background"
              : "bg-primary text-primary-fg"
          }`}
        >
          {pending ? "Recording…" : open === "message" ? "Send" : open === "time" ? "Grant" : "Record"}
        </button>
        <button
          type="button"
          onClick={close}
          className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          Cancel
        </button>
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function Small({
  onClick,
  children,
  danger = false,
}: {
  readonly onClick: () => void;
  readonly children: React.ReactNode;
  readonly danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md border px-2 py-1 text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
        danger ? "border-danger/40 text-danger" : "border-border text-text"
      }`}
    >
      {children}
    </button>
  );
}
