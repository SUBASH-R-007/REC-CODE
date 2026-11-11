"use client";

import { useState } from "react";

/**
 * The Launch button on the readiness page (Phase 14e).
 *
 * A client island for one reason: the launch is MINTED when the button is
 * pressed, not when the page is rendered. A token in the HTML would be
 * spent by whatever read the page first — a prefetch, a second tab, a
 * logger — and the candidate would meet "that launch has already been
 * used" on a page they had only looked at.
 *
 * So: press, POST, receive a `recx-exam://` URL, hand it to the operating
 * system. Nothing is stored, and pressing again mints another.
 */
export function LaunchExamBrowser({ slug }: { readonly slug: string }) {
  const [state, setState] = useState<"idle" | "minting" | "handed-over">("idle");
  const [error, setError] = useState<string | null>(null);

  async function launch() {
    setState("minting");
    setError(null);
    try {
      const response = await fetch(`/api/exam/browser/launch/${encodeURIComponent(slug)}`, { method: "POST" });
      const body = (await response.json().catch(() => null)) as { launchUrl?: string; error?: string } | null;
      if (!response.ok || typeof body?.launchUrl !== "string") {
        setError(body?.error ?? "The launch could not be prepared. Try again, or tell your invigilator.");
        setState("idle");
        return;
      }
      /**
       * `location.href` rather than an anchor: a custom scheme that no
       * application has registered does nothing at all, silently, and
       * there is no event to tell us so. That is why the sentence below
       * appears as soon as we have handed it over — the candidate, not
       * the page, is the one who can see whether a window opened.
       */
      setState("handed-over");
      window.location.href = body.launchUrl;
    } catch {
      setError("The launch could not be prepared. Check your connection and try again.");
      setState("idle");
    }
  }

  return (
    <div className="space-y-3">
      {error ? (
        <p role="alert" className="rounded-md border border-danger/40 bg-danger-subtle px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <button
        type="button"
        onClick={() => void launch()}
        disabled={state === "minting"}
        className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-fg disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {state === "minting" ? "Preparing…" : "Launch REC Exam Browser"}
      </button>
      {state === "handed-over" ? (
        <p className="text-sm text-text" role="status">
          REC Exam Browser should be opening. If nothing happened, it is not installed on this machine — install it
          below, then press Launch again. Nothing has started and your attempts are untouched.
        </p>
      ) : null}
    </div>
  );
}
