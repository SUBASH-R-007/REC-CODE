import "server-only";
import {
  RECOMMEND_DRIVE_HORIZON_DAYS,
  RECOMMEND_ROTATE_AFTER,
  REVISION_INTERVALS,
  TIER_TARGETS,
  TOPICS,
  campusDay,
  type RecommendInputs,
  type RecommendProblem,
  type Topic,
  type WeakTopicCandidate,
} from "@recx/shared";
import { db } from "@/lib/db";

/**
 * The candidates the recommender chooses between (Phase 12f).
 *
 * The engine is pure (`recommend()` in @recx/shared); this is the half
 * that reads. Each rung is one bounded query, and the three new ones are
 * the payoff of the three phases before this: a revision card that is due
 * (12c), a problem a company whose drive is coming has actually been
 * reported asking (12e), and the topic readiness says is holding the
 * student back.
 *
 * Nothing here writes. The recommendation is derived on every render, so
 * there is no stored pick to go stale and nothing for a GET to mutate
 * (`tests/repo/render-read-only.test.ts`).
 */

const PUBLISHED = { status: "PUBLISHED", liveVersionId: { not: null } } as const;
const PROBLEM_REF = { id: true, slug: true, displayCode: true, title: true, difficulty: true } as const;

/** How many of the student's last problems the rotation rule looks at. */
const ROTATION_WINDOW = RECOMMEND_ROTATE_AFTER;
/** Weakest topics offered to the engine, so rotation has somewhere to go. */
const WEAK_TOPICS = 3;

export interface RecommendExtras {
  revision: RecommendInputs["revision"];
  drive: RecommendInputs["drive"];
  weakTopics: WeakTopicCandidate[];
  recentTopics: Topic[];
}

export async function loadRecommendExtras(userId: string, now: Date = new Date()): Promise<RecommendExtras> {
  const [revision, drive, weakTopics, recentTopics] = await Promise.all([
    dueRevision(userId, now),
    driveProblem(userId, now),
    weakestTopics(userId),
    recentProblemTopics(userId),
  ]);
  return { revision, drive, weakTopics, recentTopics };
}

/** The most overdue revision card whose problem is still published. */
async function dueRevision(userId: string, now: Date): Promise<RecommendInputs["revision"]> {
  const today = campusDay(now);
  const card = await db.revisionCard.findFirst({
    where: { userId, learnedAt: null, dueOn: { lte: new Date(`${today}T00:00:00.000Z`) }, problem: PUBLISHED },
    orderBy: [{ dueOn: "asc" }, { lapses: "desc" }, { problemId: "asc" }],
    select: { stage: true, dueOn: true, problem: { select: PROBLEM_REF } },
  });
  if (!card) return null;
  const dueOn = card.dueOn.toISOString().slice(0, 10);
  return {
    problem: card.problem,
    overdueDays: Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${dueOn}T00:00:00Z`)) / 86_400_000)),
    stepDays: REVISION_INTERVALS[Math.min(card.stage, REVISION_INTERVALS.length - 1)]!,
  };
}

/**
 * A drive inside the horizon, and the problem its company has been
 * reported asking most that this student has not solved.
 *
 * Ordered by how often it was asked, which is the number the interview
 * archive exists to produce. A curated tag with frequency 0 sorts last and
 * is still offered — the placement cell's guess is better than nothing
 * when nobody has reported an interview yet — but a reported one wins.
 */
async function driveProblem(userId: string, now: Date): Promise<RecommendInputs["drive"]> {
  const horizon = new Date(now.getTime() + RECOMMEND_DRIVE_HORIZON_DAYS * 86_400_000);
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { batchYear: true, departmentCode: true },
  });
  const drives = await db.placementDrive.findMany({
    where: {
      archivedAt: null,
      companyId: { not: null },
      driveOn: { gte: new Date(`${campusDay(now)}T00:00:00.000Z`), lte: horizon },
      ...(user?.batchYear ? { OR: [{ eligibleBatchYear: null }, { eligibleBatchYear: user.batchYear }] } : {}),
    },
    orderBy: { driveOn: "asc" },
    take: 5,
    select: { companyId: true, companyName: true, driveOn: true, eligibleDepartmentCodes: true },
  });

  for (const drive of drives) {
    // A drive that names departments and not this student's is not theirs.
    if (
      drive.eligibleDepartmentCodes.length > 0 &&
      user?.departmentCode &&
      !drive.eligibleDepartmentCodes.includes(user.departmentCode)
    ) {
      continue;
    }
    const tag = await db.problemCompanyTag.findFirst({
      where: {
        companyId: drive.companyId!,
        problem: { ...PUBLISHED, statuses: { none: { userId, status: "SOLVED" } } },
      },
      orderBy: [{ frequency: "desc" }, { problemId: "asc" }],
      select: { frequency: true, problem: { select: PROBLEM_REF } },
    });
    if (!tag) continue;
    return {
      companyName: drive.companyName,
      daysAway: Math.max(
        0,
        Math.round((Date.parse(`${drive.driveOn.toISOString().slice(0, 10)}T00:00:00Z`) - Date.parse(`${campusDay(now)}T00:00:00Z`)) / 86_400_000),
      ),
      askedCount: tag.frequency,
      problem: tag.problem,
    };
  }
  return null;
}

/**
 * The topics with the fewest UNASSISTED solves against the PRODUCT tier's
 * per-topic target, weakest first, each with an unsolved problem in it.
 *
 * Unassisted, because that is what readiness counts (SPEC §9) and a
 * recommender that pointed at a topic the student had "covered" with the
 * editorial open would be arguing with the score on the next page. The
 * PRODUCT target is the middle one: SERVICE sets no per-topic target at
 * all, and TOP's would mark almost everybody weak at almost everything.
 */
async function weakestTopics(userId: string): Promise<WeakTopicCandidate[]> {
  const target = TIER_TARGETS.PRODUCT.perTopic ?? 4;
  const solved = await db.problemTag.groupBy({
    by: ["topic"],
    where: { problem: { statuses: { some: { userId, status: "SOLVED", assisted: false } } } },
    _count: { topic: true },
  });
  const have = new Map<string, number>(solved.map((row) => [row.topic, row._count.topic]));

  const ranked = [...TOPICS]
    .map((topic) => ({ topic, count: have.get(topic) ?? 0 }))
    .filter((row) => row.count < target)
    .sort((a, b) => a.count - b.count || TOPICS.indexOf(a.topic) - TOPICS.indexOf(b.topic));

  const out: WeakTopicCandidate[] = [];
  for (const row of ranked) {
    if (out.length >= WEAK_TOPICS) break;
    const problem = await db.problem.findFirst({
      where: {
        ...PUBLISHED,
        tags: { some: { topic: row.topic } },
        statuses: { none: { userId, status: "SOLVED" } },
      },
      orderBy: [{ difficulty: "asc" }, { displayCode: "asc" }],
      select: PROBLEM_REF,
    });
    if (problem) out.push({ topic: row.topic, have: row.count, target, problem });
  }
  return out;
}

/**
 * The topics of the student's last few judged problems, newest first.
 *
 * One topic per PROBLEM, not per submission: five submissions on one array
 * problem is one array problem, and counting them as five would rotate a
 * student off a topic they have barely touched. A problem with several
 * topics contributes its first in `TOPICS` order, so the answer is stable.
 */
async function recentProblemTopics(userId: string): Promise<Topic[]> {
  const rows = await db.submission.findMany({
    where: { userId, origin: "PRACTICE", status: "DONE", verdict: { not: null } },
    orderBy: { createdAt: "desc" },
    take: ROTATION_WINDOW * 8,
    select: { problemId: true, problem: { select: { tags: { select: { topic: true } } } } },
  });

  const seen = new Set<string>();
  const topics: Topic[] = [];
  for (const row of rows) {
    if (seen.has(row.problemId)) continue;
    seen.add(row.problemId);
    const ordered = row.problem.tags
      .map((tag) => tag.topic as Topic)
      .sort((a, b) => TOPICS.indexOf(a) - TOPICS.indexOf(b));
    if (ordered[0]) topics.push(ordered[0]);
    if (topics.length >= ROTATION_WINDOW) break;
  }
  return topics;
}

export type { RecommendProblem };
