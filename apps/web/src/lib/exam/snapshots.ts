import "server-only";
import { createHash } from "node:crypto";
import {
  MAX_SNAPSHOTS_PER_ATTEMPT,
  SNAPSHOT_MAX_BYTES,
  clampAtMs,
  diffLines,
  elapsedMs,
  parseLinePatch,
  reconstructTimeline,
  serialiseLinePatch,
} from "@recx/shared";
import { db } from "@/lib/db";
import type { AttemptGuardOk } from "@/lib/exam/attempt";

/**
 * Editor snapshots (Phase 6c): writing them, and reading them back.
 *
 * SPEC §5: "Every 30s while dirty, plus on every run and submit. Cap 200 per
 * attempt, 64 KB each; store the first per question in full and the rest as
 * unified diffs, reconstructed on read."
 *
 * The storage shape is the interesting part. A three-hour sitting with 200
 * snapshots of a 20 KB file is 4 MB of near-identical text per candidate, and
 * 5,000 candidates make that 20 GB for one exam. Diffs make it a rounding
 * error, and the `contentHash` of each version is stored whole so a
 * reconstruction can be checked rather than trusted.
 *
 * `AttemptSnapshot` is append-only in the database (`recx_refuse_snapshot_
 * change`), which is what makes the timeline evidence: it convicts a paste
 * and, just as often, exonerates a candidate whose file grows four lines a
 * minute with failed runs in between.
 */

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export type SnapshotTrigger = "TICK" | "RUN" | "SUBMIT" | "PASTE";

export interface SnapshotWriteResult {
  readonly stored: boolean;
  /** Why it was not stored, for the client's save-state pill. */
  readonly reason?: "unchanged" | "too_large" | "capped";
  /** True when this one was stored whole rather than as a delta. */
  readonly whole: boolean;
  readonly contentHash: string;
  readonly count: number;
}

/**
 * Store one snapshot of one question's editor.
 *
 * Decisions worth stating, because each one is a trade-off rather than an
 * obvious choice:
 *
 *   - an unchanged file is NOT stored. The 30-second tick fires while the
 *     candidate is reading, and 200 identical snapshots would spend the
 *     attempt's whole budget on the minutes they were thinking.
 *   - over 64 KB is refused rather than truncated. A truncated snapshot is
 *     evidence of nothing and would read as a deletion in the timeline.
 *   - at the cap, writing stops. The budget is per attempt, and the first
 *     200 snapshots of a sitting are the ones that show how the answer was
 *     built; the last ones show it already built.
 */
export async function writeSnapshot(
  guard: AttemptGuardOk,
  input: {
    readonly questionId: string;
    readonly language: string;
    readonly source: string;
    readonly trigger: SnapshotTrigger;
    readonly atMs: number;
  },
): Promise<SnapshotWriteResult> {
  const { attempt, now } = guard;
  const contentHash = sha256(input.source);

  if (Buffer.byteLength(input.source, "utf8") > SNAPSHOT_MAX_BYTES) {
    return { stored: false, reason: "too_large", whole: false, contentHash, count: 0 };
  }

  const count = await db.attemptSnapshot.count({ where: { attemptId: attempt.id } });
  if (count >= MAX_SNAPSHOTS_PER_ATTEMPT) {
    return { stored: false, reason: "capped", whole: false, contentHash, count };
  }

  // The previous snapshot of THIS question, which is what a delta is against.
  const previous = await db.attemptSnapshot.findFirst({
    where: { attemptId: attempt.id, questionId: input.questionId },
    orderBy: [{ atMs: "desc" }, { createdAt: "desc" }],
    select: { contentHash: true },
  });

  if (previous?.contentHash === contentHash) {
    return { stored: false, reason: "unchanged", whole: false, contentHash, count };
  }

  // A delta needs the text it is against, so the question's timeline is
  // reconstructed. Bounded by the per-attempt cap, so this reads at most 200
  // rows of mostly-small deltas.
  let body = input.source;
  let isDiff = false;
  if (previous) {
    const timeline = await db.attemptSnapshot.findMany({
      where: { attemptId: attempt.id, questionId: input.questionId },
      orderBy: [{ atMs: "asc" }, { createdAt: "asc" }],
      select: { content: true, isDiff: true },
    });
    try {
      const versions = reconstructTimeline(timeline);
      const latest = versions[versions.length - 1] ?? "";
      const patch = serialiseLinePatch(diffLines(latest, input.source));
      // A delta larger than the text it encodes is not a saving. Re-basing
      // with a whole snapshot also repairs a timeline whose head is wrong.
      if (patch.length < input.source.length) {
        body = patch;
        isDiff = true;
      }
    } catch (error) {
      // An unreconstructable timeline must not stop the candidate's work
      // being recorded: store this one whole, which re-bases the chain.
      console.error(`[exam] attempt ${attempt.id}: snapshot timeline unreadable, re-basing`, error);
    }
  }

  await db.attemptSnapshot.create({
    data: {
      attemptId: attempt.id,
      questionId: input.questionId,
      atMs: clampAtMs(input.atMs, elapsedMs(attempt.startedAt, now)),
      language: input.language,
      content: body,
      contentHash,
      isDiff,
      trigger: input.trigger,
    },
    select: { id: true },
  });

  return { stored: true, whole: !isDiff, contentHash, count: count + 1 };
}

export interface SnapshotVersion {
  readonly atMs: number;
  readonly trigger: SnapshotTrigger;
  readonly language: string;
  readonly source: string;
  /** True when the rebuilt text hashes to what was stored. */
  readonly verified: boolean;
}

/**
 * A question's timeline, rebuilt. Every version carries whether its hash
 * matched, because this is shown to a student in their own report and in an
 * appeal: "we reconstructed this and it checks out" is a claim that has to be
 * checkable, and a version that does not verify must be visibly marked
 * rather than quietly presented as fact.
 */
export async function readSnapshotTimeline(args: {
  readonly attemptId: string;
  readonly questionId: string;
}): Promise<SnapshotVersion[]> {
  const rows = await db.attemptSnapshot.findMany({
    where: { attemptId: args.attemptId, questionId: args.questionId },
    orderBy: [{ atMs: "asc" }, { createdAt: "asc" }],
    select: { atMs: true, trigger: true, language: true, content: true, contentHash: true, isDiff: true },
  });
  if (rows.length === 0) return [];

  const rebuilt = reconstructTimeline(rows);
  return rows.map((row, i) => {
    const source = rebuilt[i] ?? "";
    return {
      atMs: row.atMs,
      trigger: row.trigger as SnapshotTrigger,
      language: row.language,
      source,
      verified: sha256(source) === row.contentHash,
    };
  });
}

/** Parse a stored delta without rebuilding a whole timeline (for diagnostics). */
export function readStoredPatch(content: string) {
  return parseLinePatch(content);
}
