"use client";

import { useCallback, useState } from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import { Check, X } from "lucide-react";

/**
 * The readiness check's device step (Phase 6d).
 *
 * SPEC §5: "A fresh assertion against a server challenge is required to start
 * any REMOTE_MONITORED or LAB_SUPERVISED attempt."
 *
 * It sits on the readiness page rather than inside the arena because the
 * clock starts in the arena: a candidate must be able to find out their key
 * is not working BEFORE their exam is running, while an invigilator still
 * has time to enrol the machine or issue a loaner.
 *
 * Every refusal message the server can return names the loaner, because the
 * honest answer to "my laptop died" must not look like "you cannot sit the
 * exam".
 */
export function DeviceCheck({
  slug,
  onVerified,
}: {
  readonly slug: string;
  readonly onVerified: (required: boolean) => void;
}) {
  const [state, setState] = useState<"idle" | "busy" | "verified" | "not_required">("idle");
  const [error, setError] = useState<string | null>(null);

  const verify = useCallback(async () => {
    setError(null);
    setState("busy");
    try {
      const optionsResponse = await fetch("/api/exam/device/assert", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ step: "options", slug }),
      });
      const optionsBody = (await optionsResponse.json()) as {
        required?: boolean;
        options?: unknown;
        error?: string;
      };
      if (optionsResponse.ok && optionsBody.required === false) {
        // This assessment does not need a device. Not an error, and not
        // something to make the candidate think about.
        setState("not_required");
        onVerified(false);
        return;
      }
      if (!optionsResponse.ok || !optionsBody.options) {
        setError(optionsBody.error ?? "Could not start the device check.");
        setState("idle");
        return;
      }

      const assertion = await startAuthentication({ optionsJSON: optionsBody.options as never });

      const verifyResponse = await fetch("/api/exam/device/assert", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          step: "verify",
          slug,
          challenge: (optionsBody.options as { challenge: string }).challenge,
          response: assertion,
        }),
      });
      const verifyBody = (await verifyResponse.json()) as { verified?: boolean; error?: string };
      if (!verifyResponse.ok || verifyBody.verified !== true) {
        setError(verifyBody.error ?? "That device could not be verified.");
        setState("idle");
        return;
      }
      setState("verified");
      onVerified(true);
    } catch (cause) {
      const name = (cause as { name?: string }).name;
      setError(
        name === "NotAllowedError"
          ? "The device prompt was cancelled or timed out. Try again."
          : "This browser could not use your registered device. Tell your invigilator — they can enrol this machine or issue a loaner.",
      );
      setState("idle");
    }
  }, [slug, onVerified]);

  const done = state === "verified" || state === "not_required";

  return (
    <li className="rounded-lg border border-border p-4">
      <p className="flex items-center gap-2 text-sm font-medium text-text">
        <span
          aria-hidden
          className={`flex h-5 w-5 items-center justify-center rounded-full border ${
            done ? "border-success/40 bg-success-subtle text-success" : "border-border text-text-secondary"
          }`}
        >
          {done ? <Check className="h-3 w-3" strokeWidth={3} /> : <X className="h-3 w-3" strokeWidth={3} />}
        </span>
        Your registered device works
        <span className="sr-only">{done ? " — passed" : " — not yet checked"}</span>
      </p>

      {state === "not_required" ? (
        <p className="mt-2 text-xs text-text-secondary">
          This assessment does not need a registered device.
        </p>
      ) : (
        <>
          <p className="mt-2 text-xs text-text-secondary">
            This assessment is bound to a device your department enrolled for you. Checking it now means there
            is still time to sort out a problem — your clock has not started.
          </p>
          <button
            type="button"
            disabled={state === "busy" || state === "verified"}
            onClick={() => void verify()}
            className="mt-3 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-text disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {state === "busy" ? "Waiting for your device…" : state === "verified" ? "Verified" : "Check my device"}
          </button>
        </>
      )}

      {error ? (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </li>
  );
}
