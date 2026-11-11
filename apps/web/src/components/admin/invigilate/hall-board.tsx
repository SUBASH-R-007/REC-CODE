"use client";

import { useEffect, useRef, useState } from "react";
import { formatClock, type PresenceRun } from "@recx/shared";
import { CandidateActions } from "@/components/admin/invigilate/candidate-actions";

/**
 * The hall, live (Phase 6e).
 *
 * SPEC §5 on what this screen shows and what it must not:
 *
 *   Show evidence chips, never a guilt verdict, and never a student's photo
 *   next to a flag count.
 *
 * So each row carries presence, a clock and COUNTS of what was recorded. No
 * band, no points, no integrity score — those belong to the review queue, and
 * putting them in front of someone who is invigilating turns a supervisor
 * into a judge mid-exam. There is no photograph on this screen at all.
 *
 * Amber is DISCONNECTED, and amber means "check on them", not "suspect them":
 * SPEC §5 is explicit that "DISCONNECTED is never a flag".
 */

export interface HallCandidateView {
  readonly attemptId: string;
  readonly name: string;
  readonly collegeId: string;
  readonly seatLabel: string | null;
  readonly status: string;
  readonly presence: "CONNECTED" | "IDLE" | "DISCONNECTED" | "NOT_STARTED" | "FINISHED";
  readonly msRemaining: number;
  readonly maxGapSeconds: number;
  readonly timeline: readonly PresenceRun[];
  readonly counts: { readonly focusLosses: number; readonly fullscreenExits: number; readonly pastes: number };
  readonly pausedMs: number;
  readonly pendingMessages: number;
  readonly terminationPending: boolean;
  readonly accommodationFlags: readonly string[];
}

export interface HallViewClient {
  readonly sessionId: string;
  readonly label: string;
  readonly room: string | null;
  readonly assessmentTitle: string;
  readonly candidates: readonly HallCandidateView[];
  readonly counts: {
    readonly sitting: number;
    readonly disconnected: number;
    readonly finished: number;
    readonly notStarted: number;
  };
  readonly serverNow: string;
}

const PRESENCE_TONE: Readonly<Record<HallCandidateView["presence"], string>> = Object.freeze({
  CONNECTED: "border-success/40 bg-success-subtle text-success",
  IDLE: "border-border bg-elevated text-text-secondary",
  // Amber: check on them. Never a flag (SPEC §5).
  DISCONNECTED: "border-warning/40 bg-warning-subtle text-warning",
  NOT_STARTED: "border-border bg-surface text-text-secondary",
  FINISHED: "border-border bg-surface text-text-secondary",
});

const PRESENCE_LABEL: Readonly<Record<HallCandidateView["presence"], string>> = Object.freeze({
  CONNECTED: "Connected",
  IDLE: "Idle",
  DISCONNECTED: "Disconnected",
  NOT_STARTED: "Not started",
  FINISHED: "Finished",
});

export function HallBoard({ initial }: { readonly initial: HallViewClient }) {
  const [view, setView] = useState(initial);
  const [stale, setStale] = useState(false);
  const source = useRef<EventSource | null>(null);

  useEffect(() => {
    // The server pushes a frame only when something a viewer can see has
    // changed, so an idle hall of 60 candidates streams nothing.
    const es = new EventSource(`/api/admin/invigilate/${initial.sessionId}/live`);
    source.current = es;
    es.onmessage = (event) => {
      try {
        setView(JSON.parse(event.data as string) as HallViewClient);
        setStale(false);
      } catch {
        // A malformed frame is not worth tearing the dashboard down over.
      }
    };
    es.onerror = () => {
      // EventSource reconnects by itself; say so rather than pretending the
      // numbers on screen are current.
      setStale(true);
    };
    return () => {
      es.close();
      source.current = null;
    };
  }, [initial.sessionId]);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <Count label="Sitting" value={view.counts.sitting} tone="text-success" />
        <Count label="Disconnected" value={view.counts.disconnected} tone="text-warning" />
        <Count label="Finished" value={view.counts.finished} tone="text-text-secondary" />
        <Count label="Not started" value={view.counts.notStarted} tone="text-text-secondary" />
        {stale ? (
          <p role="status" className="ml-auto text-xs text-warning">
            Reconnecting — the numbers below may be a few seconds old.
          </p>
        ) : null}
      </div>

      <ul className="mt-4 flex flex-col gap-2">
        {view.candidates.map((candidate) => (
          <li key={candidate.attemptId} className="rounded-xl border border-border bg-surface p-4">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-text">
                  {candidate.seatLabel ? `${candidate.seatLabel} · ` : ""}
                  {candidate.name}
                </p>
                <p className="mt-0.5 text-xs text-text-secondary tabular-nums">{candidate.collegeId}</p>
              </div>

              <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${PRESENCE_TONE[candidate.presence]}`}>
                {PRESENCE_LABEL[candidate.presence]}
              </span>

              {candidate.presence === "CONNECTED" || candidate.presence === "IDLE" || candidate.presence === "DISCONNECTED" ? (
                <span className="font-mono text-sm tabular-nums text-text">{formatClock(candidate.msRemaining)}</span>
              ) : null}

              {candidate.pausedMs > 0 ? (
                <span className="rounded-full border border-info/40 bg-info-subtle px-2 py-0.5 text-xs text-info">
                  +{Math.round(candidate.pausedMs / 60_000)} min granted
                </span>
              ) : null}

              {/* Evidence chips: counts of what was recorded, never a verdict. */}
              <Chips candidate={candidate} />

              {candidate.terminationPending ? (
                <span className="rounded-full border border-danger/40 bg-danger-subtle px-2 py-0.5 text-xs text-danger">
                  Termination awaiting a second staff member
                </span>
              ) : null}

              <CandidateActions
                attemptId={candidate.attemptId}
                name={candidate.name}
                live={candidate.presence !== "FINISHED" && candidate.presence !== "NOT_STARTED"}
                terminationPending={candidate.terminationPending}
              />
            </div>

            <Timeline timeline={candidate.timeline} gapSeconds={candidate.maxGapSeconds} />
          </li>
        ))}
      </ul>

      {view.candidates.length === 0 ? (
        <p className="mt-6 text-sm text-text-secondary">Nobody is seated in this hall yet.</p>
      ) : null}
    </div>
  );
}

function Count({ label, value, tone }: { readonly label: string; readonly value: number; readonly tone: string }) {
  return (
    <p className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm">
      <span className={`font-semibold tabular-nums ${tone}`}>{value}</span>{" "}
      <span className="text-text-secondary">{label}</span>
    </p>
  );
}

function Chips({ candidate }: { readonly candidate: HallCandidateView }) {
  const chips: string[] = [];
  if (candidate.counts.focusLosses > 0) chips.push(`Focus lost ${candidate.counts.focusLosses}`);
  if (candidate.counts.fullscreenExits > 0) chips.push(`Left full screen ${candidate.counts.fullscreenExits}`);
  if (candidate.counts.pastes > 0) chips.push(`Pasted ${candidate.counts.pastes}`);
  if (chips.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1.5">
      {chips.map((chip) => (
        <span key={chip} className="rounded-full border border-border px-2 py-0.5 text-xs text-text-secondary">
          {chip}
        </span>
      ))}
      {/*
        An accommodation discounts some signals. The invigilator is told that
        much and no more — never the kind, never the reason, never a
        disability label (SPEC §7).
      */}
      {candidate.accommodationFlags.length > 0 ? (
        <span className="rounded-full border border-info/40 bg-info-subtle px-2 py-0.5 text-xs text-info">
          Some signals are discounted for this candidate
        </span>
      ) : null}
    </span>
  );
}

/**
 * The presence strip, straight from the bitmap the server owns. A candidate
 * who stopped reporting leaves zeros in it, which is exactly what the amber
 * blocks are.
 */
function Timeline({ timeline, gapSeconds }: { readonly timeline: readonly PresenceRun[]; readonly gapSeconds: number }) {
  if (timeline.length === 0) return null;
  const total = timeline[timeline.length - 1]!.toSlot || 1;
  return (
    <div className="mt-3">
      <div
        className="flex h-2 w-full overflow-hidden rounded-full border border-border"
        role="img"
        aria-label={
          gapSeconds > 0
            ? `Presence timeline. Longest gap ${Math.round(gapSeconds / 60)} minutes.`
            : "Presence timeline. No gaps."
        }
      >
        {timeline.map((run, index) => (
          <span
            key={index}
            aria-hidden
            className={run.present ? "bg-success/60" : "bg-warning/60"}
            style={{ width: `${((run.toSlot - run.fromSlot) / total) * 100}%` }}
          />
        ))}
      </div>
      {gapSeconds > 0 ? (
        <p className="mt-1 text-xs text-text-secondary tabular-nums">
          Longest gap {Math.round(gapSeconds / 60)} min — a dropped connection, not a finding.
        </p>
      ) : null}
    </div>
  );
}
