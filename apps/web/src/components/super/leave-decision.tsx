"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Field, Textarea } from "@recx/design";
import { decideLeaveException } from "@/server/actions/super-calendar";

/**
 * Deciding one leave request (Phase 8a).
 *
 * Refusing needs a note and approving does not, which is the asymmetry the
 * CHECK enforces and the reason for it: a student who is refused has to be
 * able to read why, and act on it — re-raise with a certificate, or take it
 * to the placement cell. An approval needs no explanation to the person it
 * helps.
 *
 * Both buttons are plain buttons with visible focus. There is no hover-only
 * or drag path to a decision that changes whether somebody's fortnight counts
 * against them.
 */
export function LeaveDecision({ leaveId, student }: { leaveId: string; student: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const decide = (decision: "APPROVED" | "REJECTED") => {
    setError(null);
    if (decision === "REJECTED" && note.trim().length < 10) {
      setError("Refusing needs a reason the student can read — ten characters at least.");
      return;
    }
    start(async () => {
      const result = await decideLeaveException({
        leaveId,
        decision,
        note: note.trim().length > 0 ? note.trim() : undefined,
      });
      if (!result.ok) setError(result.error);
      else router.refresh();
    });
  };

  return (
    <div className="space-y-3">
      <Field
        label={`Note to ${student}`}
        htmlFor={`note-${leaveId}`}
        hint="Required to refuse, optional to approve."
        error={error}
      >
        <Textarea
          id={`note-${leaveId}`}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={2}
          maxLength={1000}
          placeholder="No certificate was attached; please raise it again with one."
        />
      </Field>

      <div className="flex flex-wrap gap-2">
        <Button type="button" loading={pending} onClick={() => decide("APPROVED")}>
          Approve
        </Button>
        <Button type="button" variant="secondary" loading={pending} onClick={() => decide("REJECTED")}>
          Refuse
        </Button>
      </div>
    </div>
  );
}
