import "server-only";
import {
  READINESS_TIERS,
  READINESS_TIER_LABEL,
  campusDay,
  dayDifference,
  rebuildSnapshot,
  topicCounts,
  type ComponentBreakdown,
  type ReadinessTier,
  type Topic,
} from "@recx/shared";
import { db } from "@/lib/db";
import type { MentorScope, ScopedMenteeId } from "@/lib/auth/mentor-scope";

/**
 * What a mentor of record may read (Phase 9d).
 *
 * The allowlist is the whole design. A mentor sees a mentee's NAME, their
 * coverage, how long they have been quiet and the three gaps — and nothing
 * else. Specifically never: a submission's source, a code draft, a private
 * note, a per-test detail, an accommodation, an audit row, or any integrity
 * signal at all. `tests/repo/placement-fence.test.ts` holds that list and
 * fails the build the day an unclassified private model is added.
 *
 * Every query here takes a `ScopedMenteeId`, which only lib/auth/mentor-scope
 * mints, so "whose student is this" is answered by the type system rather
 * than by remembering to filter.
 *
 * A mentor is here to have a conversation. The surface is shaped so that the
 * conversation is about coverage and effort, not about suspicion.
 */

export interface MenteeRow {
  readonly userId: ScopedMenteeId;
  readonly name: string;
  readonly collegeId: string;
  readonly batchYear: number | null;
  readonly departmentCode: string | null;
  readonly section: string | null;
  /** Days since the student last did anything, from the snapshot's own column. */
  readonly quietDays: number | null;
  readonly lastActiveOn: string | null;
  /** SERVICE readiness as a percentage OF WHAT WAS MEASURABLE, or null. */
  readonly serviceNormalised: number | null;
  readonly serviceScore: number | null;
  readonly serviceAvailableWeight: number;
  readonly assignedAt: Date;
  readonly reason: string;
}

const MENTEE_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  collegeId: true,
  batchYear: true,
  departmentCode: true,
  section: true,
} as const;

/**
 * The viewer's live mentees, newest assignment last.
 *
 * Fails closed by construction: the scope is the list of live assignments,
 * so a mentor with none gets an empty array without a query that could have
 * returned anybody.
 */
export async function myMentees(scope: MentorScope, now = new Date()): Promise<MenteeRow[]> {
  if (scope.menteeIds.length === 0) return [];
  const ids = scope.menteeIds as readonly string[];

  const [assignments, users, snapshots] = await Promise.all([
    db.mentorAssignment.findMany({
      where: { mentorId: scope.mentorId, menteeId: { in: [...ids] }, endedAt: null },
      select: { menteeId: true, assignedAt: true, reason: true },
    }),
    db.user.findMany({ where: { id: { in: [...ids] } }, select: MENTEE_SELECT }),
    latestSnapshots(ids),
  ]);

  const byId = new Map(users.map((user) => [user.id, user]));
  const byMentee = new Map(assignments.map((row) => [row.menteeId, row]));
  const today = campusDay(now);

  /**
   * Iterated over the SCOPE's ids, not over the rows that came back. Those
   * ids are already branded, so nothing here casts — and
   * tests/repo/placement-fence.test.ts asserts that lib/auth/mentor-scope.ts
   * is the only file in the app that mints a ScopedMenteeId. A cast here
   * would be a hole with a type annotation over it.
   */
  return scope.menteeIds
    .flatMap((menteeId) => {
      const assignment = byMentee.get(menteeId);
      const user = byId.get(menteeId);
      if (!assignment || !user) return [];
      const snapshot = snapshots.get(menteeId);
      const lastActiveOn = snapshot?.lastActiveOn ? campusDay(snapshot.lastActiveOn) : null;
      return [
        {
          userId: menteeId,
          name: `${user.firstName} ${user.lastName}`.trim(),
          collegeId: user.collegeId,
          batchYear: user.batchYear,
          departmentCode: user.departmentCode,
          section: user.section,
          quietDays: lastActiveOn ? dayDifference(lastActiveOn, today) : null,
          lastActiveOn,
          serviceNormalised: normalised(snapshot?.serviceScore ?? null, snapshot?.serviceAvailableWeight ?? 0),
          serviceScore: snapshot?.serviceScore ?? null,
          serviceAvailableWeight: snapshot?.serviceAvailableWeight ?? 0,
          assignedAt: assignment.assignedAt,
          reason: assignment.reason,
        } satisfies MenteeRow,
      ];
    })
    .sort((a, b) => (b.quietDays ?? -1) - (a.quietDays ?? -1) || a.name.localeCompare(b.name));
}

/** `score / availableWeight` as 0-100. Null when nothing was measurable. */
function normalised(score: number | null, availableWeight: number): number | null {
  if (score === null || availableWeight <= 0) return null;
  return Math.round((score / availableWeight) * 100);
}

const SNAPSHOT_SELECT = {
  userId: true,
  computedOn: true,
  rulesVersion: true,
  serviceScore: true,
  productScore: true,
  topScore: true,
  serviceAvailableWeight: true,
  productAvailableWeight: true,
  topAvailableWeight: true,
  components: true,
  topicUnassisted: true,
  lastActiveOn: true,
} as const;

/**
 * The newest snapshot per student, through the `[userId, computedOn DESC]`
 * index. `DISTINCT ON` in one pass rather than a query per mentee.
 */
async function latestSnapshots(ids: readonly string[]) {
  if (ids.length === 0) return new Map<string, Awaited<ReturnType<typeof rowsFor>>[number]>();
  const rows = await rowsFor(ids);
  const out = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const seen = out.get(row.userId);
    if (!seen || row.computedOn > seen.computedOn) out.set(row.userId, row);
  }
  return out;
}

function rowsFor(ids: readonly string[]) {
  return db.readinessSnapshot.findMany({
    where: { userId: { in: [...ids] } },
    select: SNAPSHOT_SELECT,
    orderBy: [{ userId: "asc" }, { computedOn: "desc" }],
  });
}

export interface MenteeTier {
  readonly tier: ReadinessTier;
  readonly label: string;
  readonly score: number | null;
  readonly availableWeight: number;
  readonly gaps: readonly ComponentBreakdown[];
}

export interface MenteeDetail {
  readonly userId: ScopedMenteeId;
  readonly name: string;
  readonly collegeId: string;
  readonly section: string | null;
  readonly assignedAt: Date;
  readonly reason: string;
  readonly computedOn: string | null;
  readonly lastActiveOn: string | null;
  readonly quietDays: number | null;
  readonly tiers: readonly MenteeTier[];
  readonly topicUnassisted: Readonly<Partial<Record<Topic, number>>>;
}

/**
 * One mentee's coverage: the same allowlisted columns the officer view uses,
 * plus nothing.
 *
 * It takes a `ScopedMenteeId`, so there is no path here that reads a student
 * this viewer is not the recorded mentor of.
 */
export async function menteeDetail(menteeId: ScopedMenteeId, mentorId: string, now = new Date()): Promise<MenteeDetail | null> {
  const [user, assignment, snapshot] = await Promise.all([
    db.user.findUnique({ where: { id: menteeId }, select: MENTEE_SELECT }),
    db.mentorAssignment.findFirst({
      where: { menteeId, mentorId, endedAt: null },
      select: { assignedAt: true, reason: true },
    }),
    db.readinessSnapshot.findFirst({
      where: { userId: menteeId },
      orderBy: { computedOn: "desc" },
      select: SNAPSHOT_SELECT,
    }),
  ]);
  if (!user || !assignment) return null;

  const today = campusDay(now);
  const lastActiveOn = snapshot?.lastActiveOn ? campusDay(snapshot.lastActiveOn) : null;
  const tiers: MenteeTier[] = [];
  if (snapshot) {
    const { tiers: scored } = rebuildSnapshot(snapshot);
    for (const tier of READINESS_TIERS) {
      const score = scored[tier];
      tiers.push({
        tier,
        label: READINESS_TIER_LABEL[tier],
        score: score.availableWeight === 0 ? null : Math.round(score.score),
        availableWeight: Math.round(score.availableWeight),
        /**
         * The three largest gaps, ranked by points available — the same
         * figure the student's own card ranks by, so a mentor and a student
         * looking at the same profile are looking at the same list. A
         * conversation that starts from a different list than the student
         * sees is a conversation that starts with an argument.
         */
        gaps: [...score.components]
          .filter((row) => row.pointsAvailable > 0)
          .sort((a, b) => b.pointsAvailable - a.pointsAvailable || a.component.localeCompare(b.component))
          .slice(0, 3),
      });
    }
  }

  return {
    userId: menteeId,
    name: `${user.firstName} ${user.lastName}`.trim(),
    collegeId: user.collegeId,
    section: user.section,
    assignedAt: assignment.assignedAt,
    reason: assignment.reason,
    computedOn: snapshot ? campusDay(snapshot.computedOn) : null,
    lastActiveOn,
    quietDays: lastActiveOn ? dayDifference(lastActiveOn, today) : null,
    tiers,
    topicUnassisted: snapshot ? topicCounts(snapshot.topicUnassisted) : {},
  };
}
