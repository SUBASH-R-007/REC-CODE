import "server-only";
import { unstable_noStore as noStore } from "next/cache";
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
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { requestIpHash } from "@/lib/ip";
import { mentorsOf } from "@/lib/auth/mentor-scope";

/**
 * The audited per-student drill-down (Phase 9e).
 *
 * Every call writes ONE `AuditLog` row, with `sensitivity: SENSITIVE` and the
 * student as `targetUserId`, and the `audit()` call comes before any read of
 * the student — so a page that threw half way still leaves the record that
 * somebody looked. The spec asks for the drill-down to be audited; what makes
 * it true is the ORDER, because a log written after the read is a log that is
 * missing exactly the reads that failed.
 *
 * `audit()` is also the only way this module touches `AuditLog`: placement
 * code may not READ it at all. An officer who could read the audit log could
 * read other officers' SENSITIVE rows, which is both a privacy failure and a
 * way to learn which students the placement cell is quietly worried about.
 * `tests/repo/placement-fence.test.ts` enforces that.
 *
 * The columns are the same allowlist the cohort surfaces use. Never a
 * submission's source, a draft, a note, a per-test detail, an accommodation
 * or any integrity signal.
 */

export interface StudentTier {
  readonly tier: ReadinessTier;
  readonly label: string;
  readonly score: number | null;
  readonly availableWeight: number;
  readonly components: readonly ComponentBreakdown[];
}

export interface PlacementStudentView {
  readonly userId: string;
  readonly name: string;
  readonly collegeId: string;
  readonly departmentCode: string | null;
  readonly batchYear: number | null;
  readonly section: string | null;
  readonly computedOn: string | null;
  readonly lastActiveOn: string | null;
  readonly quietDays: number | null;
  readonly rulesVersion: number | null;
  readonly cohortKey: string | null;
  readonly cohortSize: number | null;
  readonly tiers: readonly StudentTier[];
  readonly topicUnassisted: Readonly<Partial<Record<Topic, number>>>;
  readonly mentor: { readonly assignmentId: string; readonly name: string; readonly since: string } | null;
}

/**
 * One student, as an officer may see them.
 *
 * `noStore()` first: a drill-down must never be served from a cache, because
 * a cached render is a read that left no audit row — and because the figures
 * an officer discusses with a student have to be the ones in the database
 * now.
 */
export async function loadPlacementStudentDrilldown(
  actorId: string,
  userId: string,
): Promise<PlacementStudentView | null> {
  noStore();

  // Before the read, deliberately. See the module comment.
  await audit({
    actorId,
    action: "placement.student.view",
    entityType: "User",
    entityId: userId,
    targetUserId: userId,
    sensitivity: "SENSITIVE",
    ipHash: await requestIpHash(),
  });

  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      collegeId: true,
      role: true,
      departmentCode: true,
      batchYear: true,
      section: true,
    },
  });
  if (!user || user.role !== "STUDENT") return null;

  const [snapshot, mentors] = await Promise.all([
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
        lastActiveOn: true,
      },
    }),
    mentorsOf([userId]),
  ]);

  const mentor = mentors.get(userId);
  const lastActiveOn = snapshot?.lastActiveOn ? campusDay(snapshot.lastActiveOn) : null;
  const tiers: StudentTier[] = [];
  if (snapshot) {
    const { tiers: scored } = rebuildSnapshot(snapshot);
    for (const tier of READINESS_TIERS) {
      const score = scored[tier];
      tiers.push({
        tier,
        label: READINESS_TIER_LABEL[tier],
        score: score.availableWeight === 0 ? null : Math.round(score.score),
        availableWeight: Math.round(score.availableWeight),
        components: score.components,
      });
    }
  }

  return {
    userId: user.id,
    name: `${user.firstName} ${user.lastName}`.trim(),
    collegeId: user.collegeId,
    departmentCode: user.departmentCode,
    batchYear: user.batchYear,
    section: user.section,
    computedOn: snapshot ? campusDay(snapshot.computedOn) : null,
    lastActiveOn,
    quietDays: lastActiveOn ? dayDifference(lastActiveOn, campusDay(new Date())) : null,
    rulesVersion: snapshot?.rulesVersion ?? null,
    cohortKey: snapshot?.cohortKey ?? null,
    cohortSize: snapshot?.cohortSize ?? null,
    tiers,
    topicUnassisted: snapshot ? topicCounts(snapshot.topicUnassisted) : {},
    mentor: mentor
      ? { assignmentId: mentor.assignmentId, name: mentor.name, since: campusDay(mentor.assignedAt) }
      : null,
  };
}
