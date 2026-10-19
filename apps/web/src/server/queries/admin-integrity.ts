import "server-only";
import {
  LOW_BAND_SAMPLE_RATE,
  REVIEW_SLA_HOURS,
  inLowBandSample,
  reviewOverdue,
  type TriageBand,
  type TriageContribution,
} from "@recx/shared";
import { db } from "@/lib/db";

/**
 * Reading the review queue, a flag, and a student's own report (Phase 6e).
 *
 * The three audiences get three different things, and the differences are the
 * design:
 *
 *   - a REVIEWER sees the evidence, the band and the points, because they are
 *     deciding and the queue order has to be explainable to them;
 *   - a STUDENT sees what was recorded about their own sitting, the verdict
 *     and the reviewer's written rationale — and NEVER a band, a points total
 *     or an "integrity score". SPEC §5: "Never display a band or an
 *     'integrity score' to students or recruiters — it invites exactly the
 *     misreading we are preventing";
 *   - a SUPER-ADMIN sees overturn rates per signal, which is the only number
 *     that tells anyone whether the thresholds are any good.
 *
 * `tests/repo/integrity-isolation.test.ts` enforces the student half by
 * scanning the student tree for `substantivePoints`, `contextPoints`,
 * `queuePoints` and `integrityScore`.
 */

export interface QueueRow {
  readonly flagId: string;
  readonly attemptId: string;
  readonly band: TriageBand;
  readonly queuePoints: number;
  readonly flaggedAt: Date;
  readonly reviewDeadline: Date;
  readonly overdue: boolean;
  readonly reviewersRequired: number;
  readonly reviewsRecorded: number;
  /** A LOW-band flag in the mandatory 10% sample a human must still read. */
  readonly inSample: boolean;
  readonly studentName: string;
  readonly collegeId: string;
  readonly assessmentTitle: string;
}

/**
 * The queue, worst first.
 *
 * Ordered by band then by points, which is what the points are FOR — SPEC §5
 * calls them "severity points, used only to order the review queue". A LOW
 * flag appears only when it is in the mandatory sample, because the rest are
 * bulk-cleared and a queue that lists every LOW flag is a queue nobody
 * finishes.
 */
export async function listReviewQueue(options: { readonly includeResolved?: boolean } = {}): Promise<QueueRow[]> {
  const now = new Date();
  const flags = await db.integrityFlag.findMany({
    where: options.includeResolved ? {} : { status: "OPEN" },
    orderBy: [{ band: "desc" }, { substantivePoints: "desc" }, { flaggedAt: "asc" }],
    take: 300,
    select: {
      id: true,
      attemptId: true,
      band: true,
      substantivePoints: true,
      contextPoints: true,
      flaggedAt: true,
      reviewDeadline: true,
      reviewersRequired: true,
      _count: { select: { reviews: true } },
      attempt: {
        select: {
          user: { select: { firstName: true, lastName: true, collegeId: true } },
          assessment: { select: { title: true } },
        },
      },
    },
  });

  return flags
    .map((flag) => ({
      flagId: flag.id,
      attemptId: flag.attemptId,
      band: flag.band as TriageBand,
      queuePoints: flag.substantivePoints + flag.contextPoints,
      flaggedAt: flag.flaggedAt,
      reviewDeadline: flag.reviewDeadline,
      overdue: reviewOverdue(flag.flaggedAt, now),
      reviewersRequired: flag.reviewersRequired,
      reviewsRecorded: flag._count.reviews,
      inSample: flag.band === "LOW" ? inLowBandSample(flag.attemptId) : false,
      studentName: `${flag.attempt.user.firstName} ${flag.attempt.user.lastName}`.trim(),
      collegeId: flag.attempt.user.collegeId,
      assessmentTitle: flag.attempt.assessment.title,
    }))
    // A LOW flag outside the sample is bulk-cleared and is not queue work.
    .filter((row) => row.band !== "LOW" || row.inSample);
}

export interface FlagDetail {
  readonly flagId: string;
  readonly attemptId: string;
  readonly band: TriageBand;
  readonly substantivePoints: number;
  readonly contextPoints: number;
  readonly status: string;
  readonly flaggedAt: Date;
  readonly reviewDeadline: Date;
  readonly reviewersRequired: number;
  readonly signals: readonly TriageContribution[];
  readonly studentName: string;
  readonly collegeId: string;
  readonly assessmentTitle: string;
  /** What the sitting itself recorded, for the reviewer's timeline. */
  readonly attempt: {
    readonly startedAt: Date;
    readonly submittedAt: Date | null;
    readonly status: string;
    readonly focusLosses: number;
    readonly fullscreenExits: number;
    readonly pastes: number;
    readonly maxHeartbeatGapSeconds: number;
    /** Signals discounted for this candidate. Never the kind or the reason. */
    readonly exemptSignals: readonly string[];
  };
  readonly reviews: ReadonlyArray<{
    readonly reviewerName: string;
    readonly verdict: string;
    readonly rationale: string;
    readonly decidedAt: Date;
  }>;
  readonly appeal: {
    readonly id: string;
    readonly reason: string;
    readonly submittedAt: Date;
    readonly decideBy: Date;
    readonly outcome: string;
    readonly firstDone: boolean;
    readonly secondDone: boolean;
  } | null;
}

/**
 * Narrow a stored `signals` jsonb value. Prisma types it as JsonValue, so a
 * direct cast is a lie TypeScript rightly refuses; this checks the shape and
 * returns an empty list for anything else, because a reviewer's screen with
 * no chips is better than one that throws.
 */
function contributionsOf(value: unknown): TriageContribution[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is TriageContribution => {
    const row = entry as Partial<TriageContribution> | null;
    return typeof row?.kind === "string" && typeof row?.points === "number";
  });
}

export async function getFlagDetail(flagId: string): Promise<FlagDetail | null> {
  const flag = await db.integrityFlag.findUnique({
    where: { id: flagId },
    select: {
      id: true,
      attemptId: true,
      band: true,
      substantivePoints: true,
      contextPoints: true,
      status: true,
      flaggedAt: true,
      reviewDeadline: true,
      reviewersRequired: true,
      signals: true,
      attempt: {
        select: {
          startedAt: true,
          submittedAt: true,
          status: true,
          blurEventCount: true,
          fullscreenExitCount: true,
          pasteEventCount: true,
          maxHeartbeatGapSeconds: true,
          accommodationFlags: true,
          user: { select: { firstName: true, lastName: true, collegeId: true } },
          assessment: { select: { title: true } },
        },
      },
      reviews: {
        orderBy: { decidedAt: "asc" },
        select: {
          verdict: true,
          rationale: true,
          decidedAt: true,
          reviewer: { select: { firstName: true, lastName: true } },
        },
      },
      appeals: {
        orderBy: { submittedAt: "desc" },
        take: 1,
        select: {
          id: true,
          reason: true,
          submittedAt: true,
          decideBy: true,
          outcome: true,
          firstVerdict: true,
          secondVerdict: true,
        },
      },
    },
  });
  if (!flag) return null;

  const appeal = flag.appeals[0];
  return {
    flagId: flag.id,
    attemptId: flag.attemptId,
    band: flag.band as TriageBand,
    substantivePoints: flag.substantivePoints,
    contextPoints: flag.contextPoints,
    status: flag.status,
    flaggedAt: flag.flaggedAt,
    reviewDeadline: flag.reviewDeadline,
    reviewersRequired: flag.reviewersRequired,
    signals: contributionsOf(flag.signals),
    studentName: `${flag.attempt.user.firstName} ${flag.attempt.user.lastName}`.trim(),
    collegeId: flag.attempt.user.collegeId,
    assessmentTitle: flag.attempt.assessment.title,
    attempt: {
      startedAt: flag.attempt.startedAt,
      submittedAt: flag.attempt.submittedAt,
      status: flag.attempt.status,
      focusLosses: flag.attempt.blurEventCount,
      fullscreenExits: flag.attempt.fullscreenExitCount,
      pastes: flag.attempt.pasteEventCount,
      maxHeartbeatGapSeconds: flag.attempt.maxHeartbeatGapSeconds,
      exemptSignals: flag.attempt.accommodationFlags,
    },
    reviews: flag.reviews.map((review) => ({
      reviewerName: `${review.reviewer.firstName} ${review.reviewer.lastName}`.trim(),
      verdict: review.verdict,
      rationale: review.rationale,
      decidedAt: review.decidedAt,
    })),
    appeal: appeal
      ? {
          id: appeal.id,
          reason: appeal.reason,
          submittedAt: appeal.submittedAt,
          decideBy: appeal.decideBy,
          outcome: appeal.outcome,
          firstDone: appeal.firstVerdict !== null,
          secondDone: appeal.secondVerdict !== null,
        }
      : null,
  };
}

/**
 * Overturn rates per signal (Phase 6e, super-admin).
 *
 * SPEC §5: "Every threshold shipped is initial engineering judgement with
 * zero calibration data. The retune loop and overturn-rate reporting are
 * load-bearing, not nice-to-haves."
 *
 * So this is the number that says whether the thresholds are any good. A
 * signal whose flags are mostly cleared is a signal flagging honest students,
 * and the documented trigger below is what turns that observation into an
 * action rather than a dashboard nobody reads.
 */
export const RETUNE_TRIGGER_RATE = 0.5;
export const RETUNE_TRIGGER_MINIMUM = 20;

export interface OverturnRow {
  readonly signal: string;
  readonly flags: number;
  readonly cleared: number;
  readonly upheld: number;
  readonly overturned: number;
  /** cleared + overturned, over decided flags. */
  readonly clearRate: number;
  /** True when this signal has earned a retune by the documented rule. */
  readonly needsRetune: boolean;
}

export interface OverturnReport {
  readonly rows: readonly OverturnRow[];
  readonly totals: {
    readonly flags: number;
    readonly decided: number;
    readonly autoCleared: number;
    readonly overdue: number;
  };
  readonly slaHours: number;
  readonly lowBandSampleRate: number;
}

export async function getOverturnReport(): Promise<OverturnReport> {
  const now = new Date();
  const flags = await db.integrityFlag.findMany({
    select: { status: true, signals: true, flaggedAt: true },
    take: 5_000,
    orderBy: { flaggedAt: "desc" },
  });

  const per = new Map<string, { flags: number; cleared: number; upheld: number; overturned: number }>();
  let decided = 0;
  let autoCleared = 0;
  let overdue = 0;

  for (const flag of flags) {
    if (flag.status === "AUTO_CLEARED") autoCleared++;
    if (flag.status === "OPEN" && reviewOverdue(flag.flaggedAt, now)) overdue++;
    if (flag.status !== "OPEN") decided++;

    const signals = contributionsOf(flag.signals);
    // One count per DISTINCT signal on the flag: a flag with three pastes is
    // one data point about EXTERNAL_PASTE, not three.
    for (const kind of new Set(signals.filter((s) => s.points > 0).map((s) => String(s.kind)))) {
      const row = per.get(kind) ?? { flags: 0, cleared: 0, upheld: 0, overturned: 0 };
      row.flags++;
      if (flag.status === "CLEARED" || flag.status === "AUTO_CLEARED") row.cleared++;
      if (flag.status === "UPHELD") row.upheld++;
      if (flag.status === "OVERTURNED") row.overturned++;
      per.set(kind, row);
    }
  }

  const rows: OverturnRow[] = [...per.entries()]
    .map(([signal, row]) => {
      const decidedHere = row.cleared + row.upheld + row.overturned;
      const clearRate = decidedHere === 0 ? 0 : (row.cleared + row.overturned) / decidedHere;
      return {
        signal,
        ...row,
        clearRate,
        // The documented trigger: a signal with enough data whose flags are
        // mostly cleared is flagging honest students, and its threshold
        // should move. The minimum stops one unlucky week renaming a signal.
        needsRetune: decidedHere >= RETUNE_TRIGGER_MINIMUM && clearRate >= RETUNE_TRIGGER_RATE,
      };
    })
    .sort((a, b) => b.clearRate - a.clearRate || b.flags - a.flags);

  return {
    rows,
    totals: { flags: flags.length, decided, autoCleared, overdue },
    slaHours: REVIEW_SLA_HOURS,
    lowBandSampleRate: LOW_BAND_SAMPLE_RATE,
  };
}
