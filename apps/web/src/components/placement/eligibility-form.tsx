"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Field, Input, Select, Textarea } from "@recx/design";
import { DECISION_REASON_HINT, DRIVE_ELIGIBILITY, DRIVE_ELIGIBILITY_LABEL } from "@recx/shared";
import { recordEligibility } from "@/server/actions/placement-drives";

/**
 * Recording one person's decision about one student (Phase 9f).
 *
 * The student is entered by roll number rather than picked from a list of who
 * clears the bar. That is deliberate and it is the whole design: a list of
 * students above a threshold, beside a button that marks them eligible, is an
 * automatic decision with a human's name on it. Typing a roll number means
 * the officer has somebody in mind before the platform tells them anything.
 *
 * The reason is required, and the hint says why: it is recorded against the
 * officer's name, and it is what somebody reads months later when a student
 * asks why they were not put forward.
 *
 * A decision is never edited. The action says so when one already exists,
 * and the database refuses the update outright.
 */
export function EligibilityForm({ driveId }: { driveId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [collegeId, setCollegeId] = useState("");
  const [decision, setDecision] = useState<(typeof DRIVE_ELIGIBILITY)[number]>("ELIGIBLE");
  const [reason, setReason] = useState("");

  const submit = () => {
    setError(null);
    if (collegeId.trim().length === 0) {
      setError("Give the student's roll number.");
      return;
    }
    if (reason.trim().length < 10) {
      setError("Say why, in at least ten characters. It is recorded against your name.");
      return;
    }
    start(async () => {
      const result = await recordEligibility({
        driveId,
        // The action resolves the roll number and refuses anything that is
        // not a student, so a typo is a clear error rather than a decision
        // recorded against the wrong person.
        collegeId: collegeId.trim(),
        decision,
        reason: reason.trim(),
      });
      if (!result.ok) setError(result.error);
      else {
        setCollegeId("");
        setReason("");
        router.refresh();
      }
    });
  };

  return (
    <div className="max-w-xl space-y-4">
      <Field label="Student's roll number" htmlFor={`decide-who-${driveId}`}>
        <Input
          id={`decide-who-${driveId}`}
          value={collegeId}
          onChange={(event) => setCollegeId(event.target.value)}
          maxLength={32}
        />
      </Field>

      <Field label="Decision" htmlFor={`decide-what-${driveId}`}>
        <Select
          id={`decide-what-${driveId}`}
          value={decision}
          onChange={(event) => setDecision(event.target.value as (typeof DRIVE_ELIGIBILITY)[number])}
        >
          {DRIVE_ELIGIBILITY.map((value) => (
            <option key={value} value={value}>
              {DRIVE_ELIGIBILITY_LABEL[value]}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Why" htmlFor={`decide-why-${driveId}`} hint={DECISION_REASON_HINT} error={error}>
        <Textarea
          id={`decide-why-${driveId}`}
          rows={3}
          maxLength={1000}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </Field>

      <Button onClick={submit} disabled={pending}>
        {pending ? "Recording…" : "Record this decision"}
      </Button>
      <p className="text-xs text-muted">
        A decision is recorded once and never edited. If it changes later, that is a new decision with its own
        reason — so the record of what was decided, and why, survives the change.
      </p>
    </div>
  );
}
