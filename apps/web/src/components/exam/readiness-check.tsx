"use client";

import { useCallback, useState } from "react";
import { Check, X } from "lucide-react";
import { MONITORED_SIGNALS } from "@/components/exam/monitored-chip";

/**
 * The pre-exam readiness check (Phase 6c).
 *
 * SPEC §5: "Pre-exam readiness check (~2 min): fullscreen entry/exit, a paste
 * into a scratch box, a network round-trip, a one-line sample problem, and a
 * plain-language list of exactly which signals are recorded — this doubles as
 * the consent moment."
 *
 * "Doubles as the consent moment" is the load-bearing phrase. The list is not
 * fine print: it is the reason the start button is disabled until the
 * candidate has seen each check pass and ticked the box. SPEC §5 again:
 *
 *   No silent trapping: the deterrent requires awareness, and transparency
 *   also removes the "I didn't know" appeal.
 *
 * Each check is a real exercise of the thing it checks, not a claim about it:
 * the fullscreen check actually enters and leaves fullscreen, the paste check
 * actually takes a paste, and the network check actually round-trips to the
 * server. A readiness check that only says "looks fine" is worth nothing at
 * the moment a candidate's laptop turns out not to be.
 */

type CheckId = "fullscreen" | "paste" | "network" | "sample";

const LABELS: Readonly<Record<CheckId, string>> = Object.freeze({
  fullscreen: "Full screen works on this machine",
  paste: "Pasting works, and is recorded rather than blocked",
  network: "This machine can reach the exam server",
  sample: "You can type an answer and read a question",
});

export function ReadinessCheck({
  slug,
  durationMinutes,
  questionCount,
  proctorNote,
}: {
  readonly slug: string;
  readonly durationMinutes: number;
  readonly questionCount: number;
  readonly proctorNote: string | null;
}) {
  const [passed, setPassed] = useState<Record<CheckId, boolean>>({
    fullscreen: false,
    paste: false,
    network: false,
    sample: false,
  });
  const [consented, setConsented] = useState(false);
  const [scratch, setScratch] = useState("");
  const [answer, setAnswer] = useState("");
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [fullscreenError, setFullscreenError] = useState<string | null>(null);

  const pass = useCallback((id: CheckId) => setPassed((state) => ({ ...state, [id]: true })), []);

  const tryFullscreen = useCallback(async () => {
    setFullscreenError(null);
    try {
      await document.documentElement.requestFullscreen();
      // Leave again straight away: the point is to prove both directions work
      // before the sitting, not to hold the candidate in fullscreen now.
      await new Promise((resolve) => window.setTimeout(resolve, 400));
      if (document.fullscreenElement) await document.exitFullscreen();
      pass("fullscreen");
    } catch {
      setFullscreenError(
        "This browser refused full screen. Tell your invigilator before you start — some assessments require it.",
      );
    }
  }, [pass]);

  const tryNetwork = useCallback(async () => {
    setNetworkError(null);
    // Against this page, not against the attempt: the sitting does not exist
    // yet, and it must not — the clock starts when the candidate starts, not
    // when they test their wifi. A HEAD of this very URL still proves the
    // whole path: this machine, this network, this server, this session.
    try {
      const response = await fetch(window.location.href, {
        method: "HEAD",
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(String(response.status));
      pass("network");
    } catch {
      setNetworkError("Could not reach the exam server. Check the network with your invigilator.");
    }
  }, [pass]);

  const ready = Object.values(passed).every(Boolean) && consented;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8 p-6">
      <header>
        <h1 className="font-display text-2xl font-semibold text-text">Before you start</h1>
        <p className="mt-2 text-sm text-text-secondary">
          {questionCount} {questionCount === 1 ? "question" : "questions"} · {durationMinutes} minutes. Work
          through the four checks below — it takes about two minutes — then read what is recorded and start.
        </p>
        {proctorNote ? (
          <p className="mt-3 rounded-md border border-info/40 bg-info-subtle px-3 py-2 text-sm text-info">
            {proctorNote}
          </p>
        ) : null}
      </header>

      <ol className="flex flex-col gap-5">
        {/* 1. Fullscreen, actually entered and left. */}
        <li className="rounded-lg border border-border p-4">
          <Row done={passed.fullscreen} label={LABELS.fullscreen} />
          <button
            type="button"
            onClick={() => void tryFullscreen()}
            className="mt-3 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Test full screen
          </button>
          {fullscreenError ? <p className="mt-2 text-xs text-danger">{fullscreenError}</p> : null}
        </li>

        {/* 2. A real paste into a real box. */}
        <li className="rounded-lg border border-border p-4">
          <Row done={passed.paste} label={LABELS.paste} />
          <p className="mt-2 text-xs text-text-secondary">
            Copy anything and paste it here. Pasting is allowed during the exam — it is recorded, not blocked,
            because you will legitimately paste your own earlier code.
          </p>
          <textarea
            value={scratch}
            onChange={(event) => setScratch(event.target.value)}
            onPaste={() => pass("paste")}
            aria-label="Scratch box: paste anything here"
            rows={2}
            className="mt-2 w-full rounded-md border border-border bg-surface p-2 font-mono text-xs text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
        </li>

        {/* 3. A real round-trip to the server. */}
        <li className="rounded-lg border border-border p-4">
          <Row done={passed.network} label={LABELS.network} />
          <button
            type="button"
            onClick={() => void tryNetwork()}
            className="mt-3 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Test the connection
          </button>
          {networkError ? <p className="mt-2 text-xs text-danger">{networkError}</p> : null}
        </li>

        {/* 4. A one-line question, answered. */}
        <li className="rounded-lg border border-border p-4">
          <Row done={passed.sample} label={LABELS.sample} />
          <p className="mt-2 text-sm text-text">
            Sample question: what is <code className="font-mono">2 + 2</code>?
          </p>
          <input
            value={answer}
            onChange={(event) => {
              setAnswer(event.target.value);
              if (event.target.value.trim() === "4") pass("sample");
            }}
            aria-label="Your answer to the sample question"
            className="mt-2 w-24 rounded-md border border-border bg-surface px-2 py-1 font-mono text-sm text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
        </li>
      </ol>

      {/* The consent moment. */}
      <section className="rounded-lg border border-border bg-elevated p-4">
        <h2 className="text-sm font-semibold text-text">What is recorded during this sitting</h2>
        <p className="mt-1 text-xs text-text-secondary">
          This is the complete list. A person reviews anything unusual — nothing about this sitting is decided
          automatically, and none of it is shown to recruiters.
        </p>
        <ul className="mt-3 flex flex-col gap-1.5 text-xs text-text-secondary">
          {MONITORED_SIGNALS.map((signal) => (
            <li key={signal} className="flex gap-2">
              <span aria-hidden>·</span>
              <span>{signal}</span>
            </li>
          ))}
        </ul>
        <label className="mt-4 flex items-start gap-2 text-sm text-text">
          <input
            type="checkbox"
            checked={consented}
            onChange={(event) => setConsented(event.target.checked)}
            className="mt-0.5"
          />
          <span>I have read what is recorded and I am ready to start.</span>
        </label>
      </section>

      <div className="flex items-center gap-3">
        <a
          href={`/assessments/${slug}/attempt`}
          aria-disabled={!ready}
          onClick={(event) => {
            if (!ready) event.preventDefault();
          }}
          className={`rounded-md px-4 py-2 text-sm font-semibold ${
            ready
              ? "bg-primary text-primary-fg"
              : "pointer-events-none border border-border text-text-secondary opacity-60"
          } focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`}
        >
          Start the assessment
        </a>
        {!ready ? (
          <p className="text-xs text-text-secondary">
            Finish the checks above and tick the box to start. Your clock starts when you do.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Row({ done, label }: { readonly done: boolean; readonly label: string }) {
  return (
    <p className="flex items-center gap-2 text-sm font-medium text-text">
      <span
        aria-hidden
        className={`flex h-5 w-5 items-center justify-center rounded-full border ${
          done ? "border-success/40 bg-success-subtle text-success" : "border-border text-text-secondary"
        }`}
      >
        {done ? <Check className="h-3 w-3" strokeWidth={3} /> : <X className="h-3 w-3" strokeWidth={3} />}
      </span>
      {label}
      {/* The state in words, not only in a tick. */}
      <span className="sr-only">{done ? " — passed" : " — not yet checked"}</span>
    </p>
  );
}
