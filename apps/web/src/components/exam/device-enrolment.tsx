"use client";

import { useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import { MAX_ACTIVE_DEVICES } from "@recx/shared";

/**
 * The supervisor's enrolment screen (Phase 6d).
 *
 * SPEC §5: "supervised in-lab enrolment creates DeviceRegistration [...]
 * Include a supervised single-use loaner-device enrolment so a broken laptop
 * never blocks a student from sitting an exam."
 *
 * This component runs on the SUPERVISOR's screen, and the student touches
 * their own authenticator on the machine in front of them. That is the whole
 * security property: a student who can enrol their own device can enrol a
 * friend's, which is the impersonation WebAuthn is here to close.
 *
 *   WebAuthn also closes impersonation (a senior sitting for a junior), which
 *   is a more common and more damaging campus failure than tab-switching.
 *
 * The loaner button is as prominent as the ordinary one on purpose. A
 * supervisor reaching for it has a student standing in front of them whose
 * laptop has died minutes before an exam, and hunting for it in a menu is a
 * design that costs that student their sitting.
 */
export function DeviceEnrolment({
  student,
}: {
  readonly student: { readonly id: string; readonly name: string; readonly collegeId: string };
}) {
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function enrol(asLoaner: boolean) {
    setError(null);
    setDone(null);
    const chosen = label.trim() || (asLoaner ? "Loaner device" : "Student device");
    setBusy(true);
    try {
      const optionsResponse = await fetch("/api/exam/device/enrol", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ step: "options", userId: student.id, asLoaner }),
      });
      const optionsBody = (await optionsResponse.json()) as { options?: unknown; error?: string };
      if (!optionsResponse.ok || !optionsBody.options) {
        setError(optionsBody.error ?? "Could not start enrolment.");
        return;
      }

      // The browser prompts; the student touches their key.
      const attestation = await startRegistration({ optionsJSON: optionsBody.options as never });

      const verifyResponse = await fetch("/api/exam/device/enrol", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          step: "verify",
          userId: student.id,
          asLoaner,
          label: chosen,
          challenge: (optionsBody.options as { challenge: string }).challenge,
          response: attestation,
        }),
      });
      const verifyBody = (await verifyResponse.json()) as { label?: string; error?: string };
      if (!verifyResponse.ok) {
        setError(verifyBody.error ?? "Enrolment could not be verified.");
        return;
      }
      setDone(
        asLoaner
          ? `Loaner enrolled as "${verifyBody.label}". It will work for ONE sitting and then expire on its own.`
          : `Enrolled as "${verifyBody.label}".`,
      );
      setLabel("");
    } catch (cause) {
      // A cancelled prompt is the common case and is not an error worth
      // shouting about: the supervisor simply tries again.
      const name = (cause as { name?: string }).name;
      setError(
        name === "NotAllowedError"
          ? "The device prompt was cancelled or timed out. Try again."
          : "This browser or device could not complete enrolment. Try the lab's managed browser.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <h2 className="font-display text-lg font-semibold text-text">Enrol a device</h2>
      <p className="mt-1 text-sm text-text-secondary">
        {student.name} · {student.collegeId}. The student touches their own device on this screen, with you
        present — that is what stops someone sitting an exam for someone else. At most {MAX_ACTIVE_DEVICES}{" "}
        registered devices each; a loaner does not count towards that.
      </p>

      <label className="mt-4 block text-sm font-medium text-text">
        What to call it
        <input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          maxLength={80}
          placeholder="my laptop, or lab 3 loaner 7"
          className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        />
      </label>

      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => void enrol(false)}
          className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-fg disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {busy ? "Waiting for the device…" : "Enrol this device"}
        </button>
        {/*
          As prominent as the button above: a supervisor reaching for this has
          a student in front of them whose laptop died minutes before an exam.
        */}
        <button
          type="button"
          disabled={busy}
          onClick={() => void enrol(true)}
          className="rounded-md border border-border px-4 py-2 text-sm font-semibold text-text disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          Issue a single-use loaner
        </button>
      </div>

      {error ? (
        <p role="alert" className="mt-3 rounded-md border border-danger/40 bg-danger-subtle px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
      {done ? (
        <p role="status" className="mt-3 rounded-md border border-success/40 bg-success-subtle px-3 py-2 text-sm text-success">
          {done}
        </p>
      ) : null}
    </div>
  );
}
