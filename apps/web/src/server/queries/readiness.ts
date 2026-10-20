import "server-only";

import {
  MIN_PERCENTILE_COHORT,
  READINESS_TIERS,
  READINESS_TIER_EXAMPLES,
  READINESS_TIER_LABEL,
  campusDay,
  isStale,
  largestGaps,
  nextAction,
  rebuildSnapshot,
  topicCounts,
  type ComponentBreakdown,
  type NextAction,
  type ReadinessTier,
  type TierScore,
  type Topic,
} from "@recx/shared";
import { db } from "@/lib/db";

/**
 * A student's own readiness (Phase 9c).
 *
 * One question for one person: how much of the preparation have I covered,
 * and what is the single most useful thing to do next? So it returns the
 * three tier scores WITH the weight that was measurable beside each one, the
 * components that could not be measured and why, and one action.
 *
 * It never returns a percentile the student could use to identify a peer, a
 * band, an "integrity score", or anything a recruiter could read as a
 * judgement. It reads the stored snapshot and recomputes nothing: the number
 * a student disputes months later has to be the number the row holds.
 *
 * `userId` is read from the session by the caller and used as a where clause.
 * There is no path here that takes somebody else's id.
 */

/** Accounts the nightly run no longer includes. */
const EXCLUDED_STATUSES = ["GRADUATED", "ARCHIVED"] as const;

export interface TierView {
  readonly tier: ReadinessTier;
  readonly label: string;
  readonly examples: string;
  /** Null when nothing in the tier could be measured at all. */
  readonly score: number | null;
  /** The honest denominator, 0–100. Always shown next to the score. */
  readonly availableWeight: number;
  /** `score / availableWeight` as 0–100. What a threshold compares against. */
  readonly normalised: number | null;
  readonly components: readonly ComponentBreakdown[];
  readonly missing: readonly ComponentBreakdown[];
  readonly gaps: readonly ComponentBreakdown[];
  readonly action: NextAction | null;
}

export type MyReadiness =
  /** No row has ever been computed: a new student, or before the first run. */
  | { readonly kind: "NONE" }
  /** GRADUATED or ARCHIVED — not being assessed any more, by design. */
  | { readonly kind: "EXCLUDED" }
  | {
      readonly kind: "READY";
      /** The campus day the run computed this, as "yyyy-MM-dd". */
      readonly computedOn: string;
      /** True once the nightly run has missed at least once. */
      readonly stale: boolean;
      readonly tiers: readonly TierView[];
      /** How many peers the percentile components were ranked against. */
      readonly cohortKey: string;
      readonly cohortSize: number;
      /** Below this a percentile is a disguised ranking, so it is not taken. */
      readonly cohortRankable: boolean;
      /** The fourteen counts the breadth MIN was taken over. */
      readonly topicUnassisted: Readonly<Partial<Record<Topic, number>>>;
      readonly rulesVersion: number;
    };

/**
 * The tier the student's next action is taken from.
 *
 * SERVICE first, deliberately. The gap list is per tier and a student has to
 * be pointed at ONE thing; pointing them at the hardest tier's gap would
 * send someone with 12 easy problems solved to go and enter a rated contest.
 * The lowest rung with a gap is where the next evening is best spent, and
 * once a rung is full the action moves up on its own.
 */
function headlineTier(tiers: readonly TierView[]): TierView | null {
  for (const tier of tiers) {
    if (tier.action) return tier;
  }
  return null;
}

/** The one action the page leads with, and which tier it came from. */
export function headlineAction(
  readiness: MyReadiness,
): { readonly tier: TierView; readonly action: NextAction } | null {
  if (readiness.kind !== "READY") return null;
  const tier = headlineTier(readiness.tiers);
  return tier?.action ? { tier, action: tier.action } : null;
}

function view(tier: ReadinessTier, score: TierScore): TierView {
  return {
    tier,
    label: READINESS_TIER_LABEL[tier],
    examples: READINESS_TIER_EXAMPLES[tier],
    score: score.availableWeight === 0 ? null : Math.round(score.score),
    availableWeight: Math.round(score.availableWeight),
    normalised: score.availableWeight === 0 ? null : Math.round(score.normalised),
    components: score.components,
    missing: score.missing,
    gaps: largestGaps(score),
    action: null,
  };
}

export async function myReadiness(userId: string, now = new Date()): Promise<MyReadiness> {
  const [user, snapshot] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: userId }, select: { status: true } }),
    db.readinessSnapshot.findFirst({
      where: { userId },
      orderBy: { computedOn: "desc" },
      select: {
        computedOn: true,
        rulesVersion: true,
        cohortKey: true,
        cohortSize: true,
        components: true,
        topicUnassisted: true,
      },
    }),
  ]);

  // Order matters: a graduate with an old snapshot is EXCLUDED, not stale.
  // The page offers them the signed export, which is the thing they want.
  if ((EXCLUDED_STATUSES as readonly string[]).includes(user.status)) return { kind: "EXCLUDED" };
  if (!snapshot) return { kind: "NONE" };

  const { inputs, tiers } = rebuildSnapshot(snapshot);
  // The action is attached here rather than inside `view`, because
  // `nextAction` wants the rebuilt inputs and a TierView carries only what
  // the page renders.
  const built = READINESS_TIERS.map((tier) => ({
    ...view(tier, tiers[tier]),
    action: nextAction(tier, tiers[tier], inputs),
  }));

  const computedOn = campusDay(snapshot.computedOn);
  return {
    kind: "READY",
    computedOn,
    stale: isStale(computedOn, campusDay(now)),
    tiers: built,
    cohortKey: snapshot.cohortKey,
    cohortSize: snapshot.cohortSize,
    cohortRankable: snapshot.cohortSize >= MIN_PERCENTILE_COHORT,
    topicUnassisted: topicCounts(snapshot.topicUnassisted),
    rulesVersion: snapshot.rulesVersion,
  };
}

/**
 * Who the student's own mentor of record is, if anybody (Phase 9d).
 *
 * A student who has been assigned a mentor should be told, by name, and told
 * what that person can see. SPEC §4 names the badge as part of the role for
 * the same reason: a student told to "ask your mentor" has to know which of
 * the people answering is one.
 *
 * It returns the mentor's NAME and nothing else about them. Not their email,
 * not their college id — a student does not need a staff member's contact
 * record to recognise them in a corridor or a thread.
 *
 * It deliberately does NOT return the assignment's `reason`. That text was
 * written by an officer about the student, for a mentor to act on, and
 * rendering it back to the student would turn an internal note into a
 * message nobody chose to send them. If the placement cell wants the student
 * told something, that is a notification, written as such.
 */
export interface MyMentor {
  readonly name: string;
  /** The campus day the assignment was made, "yyyy-MM-dd". */
  readonly since: string;
}

export async function myMentor(userId: string): Promise<MyMentor | null> {
  const row = await db.mentorAssignment.findFirst({
    where: { menteeId: userId, endedAt: null },
    select: { assignedAt: true, mentor: { select: { firstName: true, lastName: true } } },
  });
  if (!row) return null;
  return {
    name: `${row.mentor.firstName} ${row.mentor.lastName}`.trim(),
    since: campusDay(row.assignedAt),
  };
}

export interface MyExportLink {
  readonly code: string;
  readonly kind: string;
  readonly issuedOn: string;
  readonly expiresOn: string | null;
  readonly revokedOn: string | null;
}

/**
 * The student's own signed links (Phase 9f).
 *
 * Dates as campus days rather than timestamps: a link's useful life is
 * measured in days, and a time of day on it invites a reader to think the
 * expiry is to the minute.
 *
 * It returns no payload and no signature. The student does not need either to
 * decide whether to withdraw a link, and a signature rendered on a page is a
 * signature that can be copied off it.
 */
export async function myExportLinks(userId: string): Promise<MyExportLink[]> {
  const rows = await db.profileExport.findMany({
    where: { userId },
    orderBy: { issuedAt: "desc" },
    take: 20,
    select: { code: true, kind: true, issuedAt: true, expiresAt: true, revokedAt: true },
  });
  return rows.map((row) => ({
    code: row.code,
    kind: row.kind,
    issuedOn: campusDay(row.issuedAt),
    expiresOn: row.expiresAt ? campusDay(row.expiresAt) : null,
    revokedOn: row.revokedAt ? campusDay(row.revokedAt) : null,
  }));
}
