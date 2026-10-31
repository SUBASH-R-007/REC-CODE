"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Field, Select, Textarea } from "@recx/design";
import { MENTOR_BADGE_LABEL } from "@recx/shared";
import { assignMentor, endAssignment } from "@/server/actions/placement-mentor";

/**
 * "Ask a mentor to follow up" (Phase 9e).
 *
 * A form submit with a visible focus ring, never a `mailto:` — SPEC §6
 * requires that, and the reason is that a `mailto:` leaves no record of who
 * was asked, which is the only thing this control exists to create.
 *
 * It sends the STUDENT nothing. A student who receives "you have been flagged
 * as at risk" learns only that a number somewhere is low, which is exactly
 * the discouragement the phase is arranged to avoid. The mentor is a person,
 * and a person deciding how to open the conversation is the whole value of
 * routing to one.
 */
export function MentorRouting({
  menteeId,
  name,
  mentors,
  current,
}: {
  menteeId: string;
  name: string;
  mentors: readonly { readonly id: string; readonly name: string }[];
  current: { readonly assignmentId: string; readonly name: string; readonly since: string } | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [mentorId, setMentorId] = useState(mentors[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const assign = () => {
    setError(null);
    if (!mentorId) {
      setError("Choose a mentor.");
      return;
    }
    if (reason.trim().length < 10) {
      setError("Give the mentor some context — ten characters or more. They are about to start a conversation.");
      return;
    }
    start(async () => {
      const result = await assignMentor({ menteeId, mentorId, reason: reason.trim() });
      if (!result.ok) setError(result.error);
      else {
        setReason("");
        setOpen(false);
        router.refresh();
      }
    });
  };

  const end = () => {
    if (!current) return;
    setError(null);
    start(async () => {
      const result = await endAssignment({ assignmentId: current.assignmentId });
      if (!result.ok) setError(result.error);
      else router.refresh();
    });
  };

  if (current) {
    return (
      <div className="space-y-2">
        <p className="text-sm">
          Routed to <strong>{current.name}</strong>{" "}
          <span className="text-text-secondary">({MENTOR_BADGE_LABEL})</span> since {current.since}.
        </p>
        <Button variant="ghost" onClick={end} disabled={pending}>
          {pending ? "Ending…" : "End this assignment"}
        </Button>
        {/* Ended, never deleted: the history of who was asked survives. */}
        <p className="text-xs text-muted">
          Ending it keeps the record that they were asked. {name} is told nothing either way.
        </p>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  if (!open) {
    return (
      <div className="space-y-1">
        <Button variant="secondary" onClick={() => setOpen(true)} disabled={mentors.length === 0}>
          Ask a mentor to follow up
        </Button>
        {mentors.length === 0 ? (
          <p className="text-xs text-muted">
            Nobody on the platform can be a mentor yet. A super-admin assigns the TA / mentor role.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Field label="Which mentor" htmlFor={`mentor-${menteeId}`}>
        <Select id={`mentor-${menteeId}`} value={mentorId} onChange={(event) => setMentorId(event.target.value)}>
          {mentors.map((mentor) => (
            <option key={mentor.id} value={mentor.id}>
              {mentor.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label="What should they know"
        htmlFor={`why-${menteeId}`}
        hint={`The mentor reads this. ${name} is not told, and nothing here reaches their record.`}
        error={error}
      >
        <Textarea
          id={`why-${menteeId}`}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
          maxLength={500}
        />
      </Field>
      <div className="flex gap-2">
        <Button onClick={assign} disabled={pending}>
          {pending ? "Asking…" : "Ask them"}
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
