import "server-only";
import {
  DRIVE_ELIGIBILITY_LABEL,
  campusDay,
  campusDayDate,
  describeDriveCount,
  driveCount,
  normalise,
  type DriveCount,
  type DriveEligibility,
  type ReadinessTier,
} from "@recx/shared";
import { db } from "@/lib/db";
import { latestRunDay } from "@/server/queries/placement-cohort";

/**
 * Drives, and the count an officer reads before deciding (Phase 9e/9f).
 *
 * The count is a number. It is not a list, it is not an ordering, and there
 * is no function here that turns it into either — SPEC §5 refuses a ranking
 * of students by readiness, and the per-drive view is where that temptation
 * is strongest, because "who clears the bar" looks so much like "who should
 * go forward".
 *
 * The one query that names students is `driveDecisions`, and it returns the
 * decisions that were RECORDED: people, reasons and the person who decided.
 * It reads what humans did, not who the platform would have chosen.
 */

export interface DriveRow {
  readonly id: string;
  readonly companyName: string;
  readonly tier: ReadinessTier;
  readonly driveOn: string;
  readonly thresholdScore: number | null;
  readonly eligibleBatchYear: number | null;
  readonly eligibleDepartmentCodes: readonly string[];
  readonly notes: string | null;
  readonly archivedOn: string | null;
  readonly decisionsRecorded: number;
}

export async function listDrives(): Promise<DriveRow[]> {
  const rows = await db.placementDrive.findMany({
    orderBy: [{ driveOn: "desc" }, { companyName: "asc" }],
    take: 200,
    select: {
      id: true,
      companyName: true,
      tier: true,
      driveOn: true,
      thresholdScore: true,
      eligibleBatchYear: true,
      eligibleDepartmentCodes: true,
      notes: true,
      archivedAt: true,
      _count: { select: { decisions: true } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    companyName: row.companyName,
    tier: row.tier,
    driveOn: campusDay(row.driveOn),
    thresholdScore: row.thresholdScore,
    eligibleBatchYear: row.eligibleBatchYear,
    eligibleDepartmentCodes: row.eligibleDepartmentCodes,
    notes: row.notes,
    archivedOn: row.archivedAt ? campusDay(row.archivedAt) : null,
    decisionsRecorded: row._count.decisions,
  }));
}

export interface DecisionRow {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly collegeId: string;
  readonly section: string | null;
  readonly decision: DriveEligibility;
  readonly decisionLabel: string;
  readonly reason: string;
  readonly decidedBy: string;
  readonly decidedOn: string;
  readonly readinessOn: string | null;
}

export interface DriveDetail {
  readonly drive: DriveRow;
  /** The count, and the sentence it is rendered as — denominator included. */
  readonly count: DriveCount;
  readonly countSentence: string;
  /** The readiness run the count was taken from. */
  readonly computedOn: string | null;
  readonly decisions: readonly DecisionRow[];
}

export async function driveDetail(driveId: string): Promise<DriveDetail | null> {
  const row = await db.placementDrive.findUnique({
    where: { id: driveId },
    select: {
      id: true,
      companyName: true,
      tier: true,
      driveOn: true,
      thresholdScore: true,
      eligibleBatchYear: true,
      eligibleDepartmentCodes: true,
      notes: true,
      archivedAt: true,
      _count: { select: { decisions: true } },
    },
  });
  if (!row) return null;

  const computedOn = await latestRunDay();
  const column = { SERVICE: "service", PRODUCT: "product", TOP: "top" }[row.tier];

  /**
   * The cohort the drive recruits from, as the drive itself defines it. Not
   * the whole college: a count over students the company would never see is a
   * number nobody can use.
   */
  const snapshots = computedOn
    ? await db.readinessSnapshot.findMany({
        where: {
          computedOn: campusDayDate(new Date(`${computedOn}T00:00:00.000Z`)),
          ...(row.eligibleBatchYear ? { batchYear: row.eligibleBatchYear } : {}),
          ...(row.eligibleDepartmentCodes.length > 0
            ? { departmentCode: { in: [...row.eligibleDepartmentCodes] } }
            : {}),
        },
        select: {
          serviceScore: true,
          serviceAvailableWeight: true,
          productScore: true,
          productAvailableWeight: true,
          topScore: true,
          topAvailableWeight: true,
        },
      })
    : [];

  const measured = snapshots.map((s) => ({
    score: s[`${column}Score` as "serviceScore"] as number | null,
    availableWeight: s[`${column}AvailableWeight` as "serviceAvailableWeight"] as number,
  }));
  const count = driveCount({ tier: row.tier, thresholdScore: row.thresholdScore }, measured);

  const decisions = await db.driveEligibilityDecision.findMany({
    where: { driveId },
    orderBy: { decidedAt: "desc" },
    take: 500,
    select: {
      id: true,
      userId: true,
      decision: true,
      reason: true,
      decidedAt: true,
      readinessComputedOn: true,
      user: { select: { firstName: true, lastName: true, collegeId: true, section: true } },
      decidedBy: { select: { firstName: true, lastName: true } },
    },
  });

  return {
    drive: {
      id: row.id,
      companyName: row.companyName,
      tier: row.tier,
      driveOn: campusDay(row.driveOn),
      thresholdScore: row.thresholdScore,
      eligibleBatchYear: row.eligibleBatchYear,
      eligibleDepartmentCodes: row.eligibleDepartmentCodes,
      notes: row.notes,
      archivedOn: row.archivedAt ? campusDay(row.archivedAt) : null,
      decisionsRecorded: row._count.decisions,
    },
    count,
    countSentence: describeDriveCount(count),
    computedOn,
    decisions: decisions.map((decision) => ({
      id: decision.id,
      userId: decision.userId,
      name: `${decision.user.firstName} ${decision.user.lastName}`.trim(),
      collegeId: decision.user.collegeId,
      section: decision.user.section,
      decision: decision.decision,
      decisionLabel: DRIVE_ELIGIBILITY_LABEL[decision.decision],
      reason: decision.reason,
      decidedBy: `${decision.decidedBy.firstName} ${decision.decidedBy.lastName}`.trim(),
      decidedOn: campusDay(decision.decidedAt),
      readinessOn: decision.readinessComputedOn ? campusDay(decision.readinessComputedOn) : null,
    })),
  };
}

/**
 * One student's readiness for a drive, for the decision form.
 *
 * Returns the NORMALISED figure beside the raw one, because the officer is
 * about to compare it with a threshold and the threshold is normalised. A
 * form that showed only the raw score would invite exactly the comparison the
 * design's review caught.
 */
export async function readinessForDecision(
  userId: string,
  tier: ReadinessTier,
): Promise<{
  readonly name: string;
  readonly collegeId: string;
  readonly score: number | null;
  readonly availableWeight: number;
  readonly normalised: number | null;
  readonly computedOn: string | null;
} | null> {
  const [user, snapshot] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true, collegeId: true, role: true } }),
    db.readinessSnapshot.findFirst({
      where: { userId },
      orderBy: { computedOn: "desc" },
      select: {
        computedOn: true,
        serviceScore: true,
        serviceAvailableWeight: true,
        productScore: true,
        productAvailableWeight: true,
        topScore: true,
        topAvailableWeight: true,
      },
    }),
  ]);
  if (!user || user.role !== "STUDENT") return null;

  const column = { SERVICE: "service", PRODUCT: "product", TOP: "top" }[tier];
  const score = snapshot ? ((snapshot[`${column}Score` as "serviceScore"] as number | null) ?? null) : null;
  const availableWeight = snapshot
    ? ((snapshot[`${column}AvailableWeight` as "serviceAvailableWeight"] as number) ?? 0)
    : 0;

  return {
    name: `${user.firstName} ${user.lastName}`.trim(),
    collegeId: user.collegeId,
    score,
    availableWeight,
    normalised: normalise({ score, availableWeight }),
    computedOn: snapshot ? campusDay(snapshot.computedOn) : null,
  };
}
