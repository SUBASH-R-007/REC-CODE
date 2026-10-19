"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Field, Input, Select, Textarea } from "@recx/design";
import { LEAVE_KINDS, LEAVE_KIND_LABEL, type LeaveKind } from "@recx/shared";
import { cancelLeaveException, requestLeaveException } from "@/server/actions/account";

/**
 * A student asking for leave to be excused (Phase 8a).
 *
 * Two things the copy has to say plainly, because getting either wrong costs
 * the student something real:
 *
 *   1. Asking is not being excused. A student who thinks the request alone
 *      stops the counter will stop practising and be counted idle for it.
 *   2. Past dates are fine. Medical leave is asked for after the illness,
 *      with the certificate handed over on discharge — that is the only shape
 *      this request ever takes, and a form that implied otherwise would send
 *      people away.
 */
export function LeaveForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [kind, setKind] = useState<LeaveKind>("MEDICAL");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const submit = () => {
    setMessage(null);
    start(async () => {
      const result = await requestLeaveException({ kind, startDate, endDate, reason });
      if (!result.ok) {
        setMessage({ tone: "bad", text: result.error });
        return;
      }
      setMessage({
        tone: "ok",
        text: "Asked. It is in the queue for the placement cell — nothing is excused until they approve it.",
      });
      setReason("");
      setStartDate("");
      setEndDate("");
      router.refresh();
    });
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Field label="Why you were away" htmlFor="leave-kind">
        <Select id="leave-kind" value={kind} onChange={(event) => setKind(event.target.value as LeaveKind)}>
          {LEAVE_KINDS.map((option) => (
            <option key={option} value={option}>
              {LEAVE_KIND_LABEL[option]}
            </option>
          ))}
        </Select>
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="First day away" htmlFor="leave-start">
          <Input
            id="leave-start"
            type="date"
            value={startDate}
            onChange={(event) => setStartDate(event.target.value)}
            required
          />
        </Field>
        <Field
          label="Last day away"
          htmlFor="leave-end"
          hint="Both days included. Dates in the past are expected — you will usually be asking after the event."
        >
          <Input
            id="leave-end"
            type="date"
            value={endDate}
            onChange={(event) => setEndDate(event.target.value)}
            required
          />
        </Field>
      </div>

      <Field
        label="What happened"
        htmlFor="leave-reason"
        hint="A sentence or two is enough. Say where any certificate is, if you have one — it is read by a person, not a form."
      >
        <Textarea
          id="leave-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
          maxLength={1000}
          required
          placeholder="Admitted with dengue on the 3rd, discharged on the 8th. Discharge summary with the health centre."
        />
      </Field>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={pending}>
          Ask for these days to be excused
        </Button>
        {message ? (
          <p
            role={message.tone === "bad" ? "alert" : "status"}
            className={`text-sm ${message.tone === "bad" ? "text-danger" : "text-success"}`}
          >
            {message.text}
          </p>
        ) : null}
      </div>
    </form>
  );
}

/**
 * Calling off your own request — before or after it was approved, and with
 * nobody's permission.
 *
 * A student who recovers early and wants their days to count again should not
 * have to ask to be counted.
 */
export function CancelLeaveButton({ leaveId }: { leaveId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-1">
      <Button
        type="button"
        variant="secondary"
        loading={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const result = await cancelLeaveException({ leaveId });
            if (!result.ok) setError(result.error);
            else router.refresh();
          })
        }
      >
        Call this off
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
