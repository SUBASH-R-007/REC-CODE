import "server-only";
import {
  countTokens,
  isExemptSignal,
  isSnapshotJump,
  reconstructTimeline,
  suggestedExemptSignals,
  type AccommodationKind,
  type ProctorEventKind,
} from "@recx/shared";
import { db } from "@/lib/db";

/**
 * Deriving SNAPSHOT_JUMP (Phase 11b), which nothing did.
 *
 * The audit that produced `tests/repo/proctoring-posture.test.ts` found this
 * one, and it is the worst of the seven: `SNAPSHOT_JUMP` is the HEAVIEST
 * substantive signal in the triage engine — thirty points, more than any
 * other single contribution — `lib/integrity/flag.ts` counts the events,
 * `packages/shared/src/exam-snapshot.ts` has the whole derivation written
 * and tested (`countTokens`, `isSnapshotJump`, the 60 % share, the 40-token
 * floor), SPEC §5 calls it "the most probative artefact" and "the one piece
 * of evidence that survives client tampering" —
 *
 * — and no code path ever wrote one. The pure half was built in Phase 6 and
 * never called, so the strongest automated evidence of a suppressed-telemetry
 * paste did not exist, and every exam since has been reviewed without it.
 *
 * Why it runs at SUBMIT rather than at snapshot time: the rule is a share of
 * the FINAL solution's tokens, and the final solution is not known until the
 * sitting ends. At submit every snapshot is stored, so one pass over the
 * timeline answers it exactly.
 *
 * It exonerates as often as it accuses, which is why the arithmetic is the
 * timeline's own and not a heuristic: a file that grows four lines a minute
 * produces nothing here.
 */

/** A paste or an insert in the same interval means the instrumentation was NOT blind. */
const BLIND_BREAKERS: readonly ProctorEventKind[] = ["EXTERNAL_PASTE", "INTERNAL_PASTE", "PROGRAMMATIC_INSERT"];

/**
 * A paste landing just outside an interval still explains it: the client
 * records the paste when it happens and the snapshot is written on the next
 * tick, so the two are seconds apart rather than simultaneous. Five seconds
 * either side, which is one flush interval.
 */
const BREAKER_GRACE_MS = 5_000;

export interface DerivedJump {
  readonly questionId: string;
  readonly atMs: number;
  readonly addedTokens: number;
  readonly finalTokens: number;
}

/**
 * Write a SNAPSHOT_JUMP for every interval where code appeared while the
 * instrumentation was blind. Idempotent: it refuses to run twice for an
 * attempt that already has derived jumps, so a resubmit or a retry cannot
 * double-count a candidate's evidence.
 */
export async function deriveSnapshotJumps(attempt: {
  readonly id: string;
  readonly startedAt: Date | null;
}): Promise<DerivedJump[]> {
  const already = await db.proctorEvent.count({
    where: { attemptId: attempt.id, kind: "SNAPSHOT_JUMP" },
  });
  if (already > 0) return [];

  const snapshots = await db.attemptSnapshot.findMany({
    where: { attemptId: attempt.id },
    orderBy: [{ questionId: "asc" }, { atMs: "asc" }, { createdAt: "asc" }],
    select: { questionId: true, atMs: true, content: true, isDiff: true, contentHash: true },
  });
  if (snapshots.length === 0) return [];

  /**
   * The exemptions this candidate holds, from the accommodation kinds FROZEN
   * onto the attempt at start — the same source `ingestProctorEvents` uses,
   * and frozen for the same reason: what counts against a candidate must not
   * change mid-sitting. A SPEECH_INPUT accommodation makes large blocks of
   * text appear legitimately, and an exempt signal scores zero rather than
   * less, because the exemption says it means nothing for this person.
   */
  const row = await db.assessmentAttempt.findUnique({
    where: { id: attempt.id },
    select: { accommodationFlags: true },
  });
  const exemptSignals = suggestedExemptSignals((row?.accommodationFlags ?? []) as AccommodationKind[]);
  const exempt = isExemptSignal("SNAPSHOT_JUMP", exemptSignals) || isExemptSignal("PROGRAMMATIC_INSERT", exemptSignals);

  const breakers = await db.proctorEvent.findMany({
    where: { attemptId: attempt.id, kind: { in: [...BLIND_BREAKERS] } },
    select: { atMs: true },
  });
  const breakerAt = breakers.map((b) => b.atMs);

  const byQuestion = new Map<string, Array<{ atMs: number; content: string; isDiff: boolean; contentHash: string }>>();
  for (const row of snapshots) {
    const list = byQuestion.get(row.questionId) ?? [];
    list.push(row);
    byQuestion.set(row.questionId, list);
  }

  const jumps: DerivedJump[] = [];
  for (const [questionId, rows] of byQuestion) {
    let versions: string[];
    try {
      versions = reconstructTimeline(rows);
    } catch {
      // An unreadable timeline derives nothing. It must never derive a
      // signal against the candidate on the strength of a bug of ours.
      continue;
    }
    const finalTokens = countTokens(versions[versions.length - 1] ?? "");
    let previousTokens = 0;
    for (let i = 0; i < versions.length; i++) {
      const tokens = countTokens(versions[i] ?? "");
      const addedTokens = tokens - previousTokens;
      previousTokens = tokens;
      const atMs = rows[i]?.atMs ?? 0;
      const from = (i > 0 ? (rows[i - 1]?.atMs ?? 0) : 0) - BREAKER_GRACE_MS;
      const to = atMs + BREAKER_GRACE_MS;
      const hadPasteOrProgrammaticInsert = breakerAt.some((at) => at >= from && at <= to);
      if (isSnapshotJump({ addedTokens, finalTokens, hadPasteOrProgrammaticInsert, exempt })) {
        jumps.push({ questionId, atMs, addedTokens, finalTokens });
      }
    }
  }

  if (jumps.length > 0) {
    const now = new Date();
    await db.proctorEvent.createMany({
      data: jumps.map((jump) => ({
        attemptId: attempt.id,
        kind: "SNAPSHOT_JUMP" as const,
        source: "SERVER" as const,
        // MEDIUM, not HIGH: it is the strongest thing here and still only
        // evidence for a human (docs/PROCTORING.md §3).
        severity: "MEDIUM" as const,
        atMs: jump.atMs,
        meta: { questionId: jump.questionId, addedTokens: jump.addedTokens, finalTokens: jump.finalTokens },
        occurredAt: now,
      })),
    });
  }
  return jumps;
}
