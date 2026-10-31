import "server-only";
import type { Prisma } from "@recx/db";
import {
  DEFAULT_HEARTBEAT_SLOT_SECONDS,
  DISCONNECTED_AFTER_SECONDS,
  EXAM_HEARTBEAT_INTERVAL_MS,
  bitmapBytes,
  checkSequence,
  clampAtMs,
  clockDrift,
  elapsedMs,
  isSlotSet,
  markSlot,
  maxGapSeconds,
  slotOf,
  type ExamHeartbeatRequest,
  type PresenceBitmap,
} from "@recx/shared";
import { db } from "@/lib/db";
import type { AttemptGuardOk } from "@/lib/exam/attempt";

/**
 * What one heartbeat does to a sitting (Phase 6b).
 *
 * The heartbeat is the only thing the exam client is told every 10 seconds,
 * and SPEC §5 puts three jobs on it:
 *
 *   1. Report `msRemaining` from the server's clock, so the candidate's timer
 *      is never a function of their own machine's clock.
 *   2. Mark presence, in the bitmap rather than in rows — "a row per
 *      heartbeat is 3.6M rows for one college-wide sitting".
 *   3. Notice, from the server's own facts, what a reviewer would want to
 *      know: a gap in presence, a gap in the client's sequence, a changed
 *      network or browser.
 *
 * What it must NOT do is decide anything about the candidate. Every event it
 * writes is SERVER-sourced evidence for a human to read (SPEC §0: the
 * maximum automatic consequence anywhere is a flag for review and withholding
 * from the public leaderboard). It does not touch `integrityScore`, it never
 * sets VOIDED, and a reconnection is a return to IN_PROGRESS — SPEC §5:
 * "DISCONNECTED is never a flag."
 */

/** Server-derived events this heartbeat decided to record. */
interface DerivedEvent {
  kind: "HEARTBEAT_GAP" | "SEQUENCE_GAP" | "IP_CHANGED" | "UA_CHANGED" | "CONCURRENT_SESSION";
  severity: "INFO" | "LOW" | "MEDIUM";
  durationMs?: number;
  meta: Prisma.InputJsonValue;
}

export interface HeartbeatOutcome {
  readonly status: string;
  readonly msRemaining: number;
  readonly serverNow: Date;
  readonly nextHeartbeatMs: number;
  /** For the log line, not for the candidate. */
  readonly derived: readonly string[];
}

/**
 * The attempt's presence bitmap, sized for its own clock. Grown rather than
 * replaced when an attempt runs past its original length (a granted break
 * extends the deadline), because `markSlot` already grows and a shrunken
 * bitmap would silently drop the later heartbeats.
 */
function presenceBitmapFor(attempt: {
  heartbeatBitmap: Uint8Array | null;
  heartbeatSlotSeconds: number;
  startedAt: Date;
  expiresAt: Date;
  pausedMs: number;
}): PresenceBitmap {
  if (attempt.heartbeatBitmap !== null) return attempt.heartbeatBitmap;
  const plannedSec = Math.max(
    1,
    Math.ceil((attempt.expiresAt.getTime() + attempt.pausedMs - attempt.startedAt.getTime()) / 1000),
  );
  const slotSeconds = attempt.heartbeatSlotSeconds || DEFAULT_HEARTBEAT_SLOT_SECONDS;
  return new Uint8Array(bitmapBytes(plannedSec, slotSeconds));
}

/**
 * Apply one heartbeat.
 *
 * Everything the attempt row needs is written in ONE conditional update,
 * guarded on the `version` the guard read, so two tabs beating at the same
 * instant cannot interleave a bitmap write and lose a marked slot. A lost
 * race is not retried: the other beat is a tenth of a second away and carries
 * the same information.
 */
export async function applyHeartbeat(
  guard: AttemptGuardOk,
  body: ExamHeartbeatRequest,
  context: { readonly ipHash: string | null; readonly uaHash: string | null },
): Promise<HeartbeatOutcome> {
  const { attempt, now } = guard;
  const slotSeconds = attempt.heartbeatSlotSeconds || DEFAULT_HEARTBEAT_SLOT_SECONDS;
  const elapsed = elapsedMs(attempt.startedAt, now);
  // Every event below is SERVER-derived, so its offset is the server's own
  // elapsed time and there is nothing to distrust. It still goes through the
  // clamp, which is the one place that knows `atMs` is an Int column.
  const atMs = clampAtMs(elapsed, elapsed);
  const derived: DerivedEvent[] = [];

  // ── Presence ───────────────────────────────────────────────────────────
  const before = presenceBitmapFor(attempt);
  const slot = slotOf(attempt.startedAt, now, slotSeconds);
  const bitmap = isSlotSet(before, slot) ? before : markSlot(before, slot);
  // +1 so the slot just marked is inside the window: `maxGapSeconds` takes an
  // exclusive bound, and without it the current slot never counts and the run
  // of zeroes before it is measured one slot short.
  const slotsElapsed = slot + 1;
  const gapSeconds = maxGapSeconds(bitmap, slotsElapsed, slotSeconds);

  // ── A gap in presence ──────────────────────────────────────────────────
  // Recorded on the beat that ENDS the gap, because that is the first moment
  // the server knows how long it was. The 45-second rule is the spec's
  // ("Missing heartbeats for 45s → DISCONNECTED").
  const silentMs = attempt.lastHeartbeatAt === null ? 0 : now.getTime() - attempt.lastHeartbeatAt.getTime();
  const reconnected = attempt.status === "DISCONNECTED";
  if (silentMs > DISCONNECTED_AFTER_SECONDS * 1000) {
    derived.push({
      kind: "HEARTBEAT_GAP",
      // A gap is a connectivity fact, not a finding. MEDIUM only once it is
      // long enough that the candidate was away from the paper, and even
      // then it is a chip on a timeline, never a score.
      severity: silentMs > 5 * 60_000 ? "MEDIUM" : "LOW",
      durationMs: Math.min(silentMs, 2_147_483_647),
      meta: { silentSeconds: Math.round(silentMs / 1000), reconnected, maxGapSeconds: gapSeconds },
    });
  }

  // ── A gap in the client's sequence ─────────────────────────────────────
  const seq = checkSequence(body.clientSeq, attempt.lastClientSeq);
  if (seq.skipped > 0) {
    derived.push({
      kind: "SEQUENCE_GAP",
      severity: "LOW",
      meta: { skipped: seq.skipped, from: attempt.lastClientSeq, to: body.clientSeq },
    });
  }

  // ── A changed network or browser ───────────────────────────────────────
  // Hashes only, compared to hashes. SPEC §4: never a raw IP, anywhere.
  if (context.ipHash !== null && attempt.ipHashLast !== null && context.ipHash !== attempt.ipHashLast) {
    derived.push({
      kind: "IP_CHANGED",
      // Normal on a phone hotspot or a campus wifi roam; it matters only
      // next to the hall's own allowlist, which Phase 6d checks here.
      severity: "LOW",
      meta: { at: "heartbeat" },
    });
  }
  if (context.uaHash !== null && attempt.uaHash !== null && context.uaHash !== attempt.uaHash) {
    derived.push({ kind: "UA_CHANGED", severity: "MEDIUM", meta: { at: "heartbeat" } });
  }

  // ── A second live session ──────────────────────────────────────────────
  // The guard decided which of the two cases this is (lib/exam/attempt.ts).
  // "concurrent" means the session that started the sitting is still alive
  // and another one is beating at it. Recorded, and nothing more: a shared
  // laptop in a hostel room and a shared password look identical from here,
  // and only a human can tell them apart.
  if (guard.sessionNotice === "concurrent") {
    derived.push({ kind: "CONCURRENT_SESSION", severity: "MEDIUM", meta: { at: "heartbeat" } });
  }

  // ── The clock ──────────────────────────────────────────────────────────
  const drift = clockDrift(body.clientNowMs, now);
  if (drift.notable) {
    // Logged, not recorded as an event: there is no clock-drift kind among
    // the 25, and a candidate's machine being 20 seconds out is an
    // operational fact about their laptop, not evidence about them. The
    // client corrects itself from `serverNow` on this same response.
    console.warn(`[exam] attempt ${attempt.id}: client clock is ${Math.round(drift.driftMs / 1000)}s out`);
  }

  // ── One conditional write ──────────────────────────────────────────────
  const msLeft = Math.max(0, attempt.expiresAt.getTime() + attempt.pausedMs - now.getTime());
  const data: Prisma.AssessmentAttemptUpdateManyMutationInput = {
    lastHeartbeatAt: now,
    heartbeatBitmap: Buffer.from(bitmap),
    // Monotonic by construction: maxGapSeconds over a growing window can
    // only grow, but GREATEST-by-hand keeps that true even if a bitmap were
    // ever replaced by a shorter one.
    maxHeartbeatGapSeconds: Math.max(attempt.maxHeartbeatGapSeconds, gapSeconds),
    lastClientSeq: seq.highWater,
    ipHashLast: context.ipHash ?? attempt.ipHashLast,
    version: { increment: 1 },
  };
  // The original session is gone and this one has taken over the sitting.
  if (guard.sessionNotice === "rebind" && guard.sessionId !== null) data.lockSessionId = guard.sessionId;
  // A beat means the candidate is back. The clock never stopped, the paper is
  // unchanged, and nothing is recorded against them for having dropped.
  if (reconnected) data.status = "IN_PROGRESS";

  const written = await db.assessmentAttempt.updateMany({
    where: { id: attempt.id, version: attempt.version },
    data,
  });

  if (written.count === 1 && derived.length > 0) {
    // Server-sourced, so no clientSeq (the CHECK requires exactly that:
    // (source = 'CLIENT') = (clientSeq IS NOT NULL)).
    await db.proctorEvent.createMany({
      data: derived.map((event) => ({
        attemptId: attempt.id,
        kind: event.kind,
        source: "SERVER" as const,
        severity: event.severity,
        atMs,
        durationMs: event.durationMs ?? null,
        meta: event.meta,
        occurredAt: now,
      })),
    });
  }

  return {
    status: reconnected && written.count === 1 ? "IN_PROGRESS" : attempt.status,
    msRemaining: msLeft,
    serverNow: now,
    nextHeartbeatMs: EXAM_HEARTBEAT_INTERVAL_MS,
    derived: derived.map((e) => e.kind),
  };
}
