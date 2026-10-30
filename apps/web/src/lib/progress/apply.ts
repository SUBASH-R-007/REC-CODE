import "server-only";
import { Prisma, type DbTx, type XpEventKind } from "@recx/db";
import { clearRestrictionOnSolve } from "@recx/db/inactivity";
import { XP_KEYS, isRestrictedStatus, makesSolveAssisted, type StreakState, type Verdict } from "@recx/shared";
import { loadXpRules } from "./xp-config";
import {
  PROGRESS_NOTIFICATION_KIND,
  PROGRESS_NOTIFICATION_LINK,
  attemptWindow,
  badgeNotification,
  badgesCrossed,
  bucketKeys,
  dateAsDay,
  dayAsDate,
  firstSolveAward,
  planProgress,
  solvedIncrements,
  streakMilestoneAward,
  streakNotification,
  type BadgeCounters,
  type DayXp,
  type ProgressPlan,
  type XpAward,
} from "./rules";

/**
 * The progress engine: everything a finalised PRACTICE submission changes
 * besides its own row — UserProblemStatus, ProblemStat, the XP ledger and its
 * period buckets, ActivityDay, UserStats (counters, topics, languages,
 * streak), study-plan progress, badges and notifications.
 *
 * It runs inside the judge-finalise transaction (src/lib/judge/finalize.ts),
 * after the guarded verdict update and under the per-user advisory lock
 * `pg_advisory_xact_lock(hashtext('user:' || userId))`. That lock serialises
 * every finalise of one student, so the few reads below (prior status, streak,
 * today's XP) cannot interleave with another of their own results. Rows that
 * other students also write — ProblemStat — are only ever changed with atomic
 * in-statement increments, and written LAST so the shared row lock is held for
 * the shortest possible time.
 *
 * Exactly-once XP: every award is an XpEvent with a unique idempotencyKey
 * (XP_KEYS.solve / XP_KEYS.streak) inserted with ON CONFLICT DO NOTHING, and
 * the buckets, ActivityDay.xp and UserStats.xpTotal move only by what was
 * actually inserted. A retried or repeated finalise can never award twice.
 * The other counters are protected by finalize's guarded update (a stale or
 * retried result never reaches this function) and by the rejudge rule in
 * planProgress().
 *
 * Contest and assessment origins are not handled here (later phases).
 */

export interface SubmissionProgressInput {
  submissionId: string;
  userId: string;
  problemId: string;
  /** The pinned version the submission was judged against (its difficulty pays the XP). */
  problemVersionId: string;
  /** Language key, e.g. "cpp20". */
  language: string;
  verdict: Verdict;
  /** Submission.createdAt — the activity moment (campus day, caps, buckets, streak). */
  submittedAt: Date;
  /** The finalise moment (lastActiveAt, lastXpAt, badge and notification times). */
  now: Date;
  /** Lane REJUDGE: an admin re-ran an already-counted submission. */
  rejudge: boolean;
}

export interface ProgressOutcome {
  firstSolve: boolean;
  assisted: boolean;
  /** XP inserted by this call (0 when nothing new was awarded). */
  xp: { solve: number; streak: number };
  /** The streak after this submission, or null when it was not touched. */
  streak: number | null;
  /** Badge keys newly awarded by this call. */
  badges: string[];
}

const nothing = (): ProgressOutcome => ({
  firstSolve: false,
  assisted: false,
  xp: { solve: 0, streak: 0 },
  streak: null,
  badges: [],
});

interface SolveContext {
  difficulty: "EASY" | "MEDIUM" | "HARD";
  assisted: boolean;
  dailyChallenge: boolean;
  activeSeconds: number | null;
  topics: string[];
}

/**
 * Apply one finalised PRACTICE submission's progress. Call inside the
 * finalise transaction, after the per-user advisory lock.
 */
export async function applySubmissionProgress(tx: DbTx, input: SubmissionProgressInput): Promise<ProgressOutcome> {
  if (input.verdict === "IE") return nothing();
  const { userId, problemId } = input;
  const xp = await loadXpRules(tx);

  /**
   * Is this account paused for inactivity (Phase 8d)?
   *
   * SPEC §5: what SOFT_RESTRICTED blocks is "leaderboard visibility, new XP
   * accrual (events still recorded, flagged `meta.restricted`), rewards" —
   * and what it does NOT block is "signing in, reading problems, solving".
   * So this read changes nothing about whether the solve is accepted or
   * recorded. It changes only whether the solve MOVES anything public.
   *
   * Read at the START of the transaction on purpose. Phase 8e clears the
   * restriction inside this same transaction when a student solves, so a
   * state read afterwards would always say "not restricted" and the spec's
   * `meta.restricted` would be unreachable. The cost to the student is one
   * solve's worth of board movement; everything they earned is in the ledger
   * and nothing has to be re-awarded (`docs/OPEN-QUESTIONS.md`).
   */
  const [priorStatus, priorStats, restricted] = await Promise.all([
    tx.userProblemStatus.findUnique({
      where: { userId_problemId: { userId, problemId } },
      select: { status: true, firstAttemptAt: true, lastAttemptAt: true },
    }),
    tx.userStats.findUnique({
      where: { userId },
      select: {
        currentStreak: true,
        longestStreak: true,
        lastActiveDate: true,
        solvedTotal: true,
        solvedMedium: true,
        solvedHard: true,
      },
    }),
    tx.user
      .findUnique({ where: { id: userId }, select: { status: true } })
      .then((row) => (row ? isRestrictedStatus(row.status) : false)),
  ]);
  const streakBefore: StreakState = {
    current: priorStats?.currentStreak ?? 0,
    longest: priorStats?.longestStreak ?? 0,
    lastActiveDate: priorStats?.lastActiveDate ? dateAsDay(priorStats.lastActiveDate) : null,
  };

  const plan = planProgress({
    verdict: input.verdict,
    rejudge: input.rejudge,
    submittedAt: input.submittedAt,
    prior: priorStatus,
    streak: streakBefore,
  });
  if (!plan) return nothing();

  const dayDate = dayAsDate(plan.day);
  const solve = plan.firstSolve ? await loadSolveContext(tx, input, dayDate) : null;
  const milestone = plan.streak?.milestone ?? null;

  // ── XP ledger first: what was actually inserted drives every XP counter.
  let earned: DayXp = { total: 0, easy: 0 };
  if (solve || milestone !== null) {
    const today = await tx.activityDay.findUnique({
      where: { userId_date: { userId, date: dayDate } },
      select: { xp: true, xpEasy: true },
    });
    earned = { total: today?.xp ?? 0, easy: today?.xpEasy ?? 0 };
  }

  let streakAward: XpAward | null = null;
  let streakXp = 0;
  if (milestone !== null) {
    const award = streakMilestoneAward(milestone, earned, xp.rules);
    const inserted = await insertXpEvent(tx, {
      userId,
      kind: "STREAK_MILESTONE",
      amount: award.amount,
      idempotencyKey: XP_KEYS.streak(userId, milestone),
      rulesVersion: xp.version,
      problemId: null,
      submissionId: input.submissionId,
      occurredAt: input.submittedAt,
      meta: { milestone, capped: award.capped, uncapped: award.uncapped, day: plan.day, restricted },
    });
    if (inserted) {
      streakAward = award;
      streakXp = award.amount;
      earned = { total: earned.total + award.amount, easy: earned.easy };
    }
  }

  let solveXp = 0;
  if (solve) {
    const award = firstSolveAward(
      {
        difficulty: solve.difficulty,
        assisted: solve.assisted,
        dailyChallenge: solve.dailyChallenge,
        earnedToday: earned,
      },
      xp.rules,
    );
    const inserted = await insertXpEvent(tx, {
      userId,
      kind: solve.dailyChallenge ? "DAILY_CHALLENGE" : "SOLVE",
      amount: award.amount,
      idempotencyKey: XP_KEYS.solve(userId, problemId),
      rulesVersion: xp.version,
      problemId,
      submissionId: input.submissionId,
      occurredAt: input.submittedAt,
      meta: {
        difficulty: solve.difficulty,
        assisted: solve.assisted,
        capped: award.capped,
        uncapped: award.uncapped,
        dailyChallenge: solve.dailyChallenge,
        day: plan.day,
        restricted,
      },
    });
    if (inserted) solveXp = award.amount;
  }
  const xpTotal = solveXp + streakXp;
  const xpEasy = solve?.difficulty === "EASY" ? solveXp : 0;

  // ── Per-user rows (this user's lock is held).
  const cohort = await touchUser(tx, userId, plan, input.now);
  await upsertProblemStatus(tx, input, plan, priorStatus, solve);
  await upsertActivityDay(tx, userId, dayDate, plan, { xp: xpTotal, xpEasy });
  const solved = solvedIncrements(solve?.difficulty ?? "EASY", plan.firstSolve);
  await upsertUserStats(tx, input, plan, solve, solved, xpTotal);
  /**
   * The boards do not move while the account is paused.
   *
   * XP is WITHHELD, never destroyed: the XpEvent above is written either way,
   * carrying `restricted: true`, so nothing has to be re-awarded when the
   * restriction lifts and no compensating row is ever needed. The ledger is
   * append-only and this is the whole reason that matters.
   */
  if (!restricted && (xpTotal > 0 || plan.firstSolve)) {
    await upsertBuckets(tx, userId, cohort, input.submittedAt, input.now, xpTotal, solved);
  }
  if (plan.firstSolve) await advanceStudyPlans(tx, userId, problemId, input.now);

  const before: BadgeCounters = {
    solvedTotal: priorStats?.solvedTotal ?? 0,
    solvedMedium: priorStats?.solvedMedium ?? 0,
    solvedHard: priorStats?.solvedHard ?? 0,
    longestStreak: streakBefore.longest,
  };
  const after: BadgeCounters = {
    solvedTotal: before.solvedTotal + (plan.firstSolve ? 1 : 0),
    solvedMedium: before.solvedMedium + solved.solvedMedium,
    solvedHard: before.solvedHard + solved.solvedHard,
    longestStreak: plan.streak?.after.longest ?? before.longestStreak,
  };
  /**
   * Rewards are the fourth thing SPEC §5 lists among what a restriction
   * blocks, and `awardBadges` is where rewards happen — so a paused account
   * crosses a badge threshold without being given the badge.
   *
   * Not lost: `badgesCrossed` is computed from the counters, which keep
   * moving, so the badge is awarded the next time they cross it with the
   * account active. A badge nobody saw arrive is a badge nobody will miss;
   * a badge awarded during a pause would make the pause look like nothing.
   */
  const badges = restricted ? [] : await awardBadges(tx, userId, badgesCrossed(before, after), input.now);

  /**
   * The cheapest exit from an inactivity restriction: doing the thing the
   * policy wanted (Phase 8e).
   *
   * SPEC §5: "Solving one problem clears NUDGED / WARNED / SOFT_RESTRICTED
   * automatically." Inside THIS transaction, so the solve and the
   * restoration either both happen or neither does — a student told to solve
   * a problem, who solved one, and who is still paused, would be the worst
   * possible outcome of a feature meant to be reassuring.
   *
   * Only on a FIRST solve: an accepted resubmission of a problem they had
   * already solved is not new work, and clearing on it would make the
   * restriction trivial to shrug off.
   */
  if (plan.firstSolve) {
    await clearRestrictionOnSolve(tx, { userId, problemId, now: input.now });
  }
  if (milestone !== null && streakAward) {
    await tx.notification.create({
      data: {
        userId,
        kind: PROGRESS_NOTIFICATION_KIND.streak,
        ...streakNotification(milestone, streakAward),
        link: PROGRESS_NOTIFICATION_LINK,
        createdAt: input.now,
      },
    });
  }

  // ── Shared row last: ProblemStat is written by every student's finalise.
  await bumpProblemStat(tx, problemId, plan, input.now);

  return {
    firstSolve: plan.firstSolve,
    assisted: solve?.assisted ?? false,
    xp: { solve: solveXp, streak: streakXp },
    streak: plan.streak?.after.current ?? null,
    badges,
  };
}

/**
 * applySubmissionProgress behind a savepoint. The verdict is the product and
 * progress is derived from it: if progress fails (a bug, a constraint), its
 * writes are rolled back to the savepoint, the error is logged loudly, and
 * the verdict still commits — a progress defect must never turn every
 * finalise into a retried callback and, after three attempts, an Internal
 * Error. Returns null when progress was rolled back.
 */
export async function applySubmissionProgressSafely(
  tx: DbTx,
  input: SubmissionProgressInput,
): Promise<ProgressOutcome | null> {
  await tx.$executeRaw`SAVEPOINT recx_progress`;
  try {
    const outcome = await applySubmissionProgress(tx, input);
    await tx.$executeRaw`RELEASE SAVEPOINT recx_progress`;
    return outcome;
  } catch (error) {
    // If the rollback itself fails the connection is unusable: let that
    // error fail the whole finalise (the worker retries the callback).
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT recx_progress`;
    console.error(
      `[progress] !!! progress for submission ${input.submissionId} (user ${input.userId}) failed and was rolled back; the verdict is kept:`,
      error,
    );
    return null;
  }
}

// ── Reads ────────────────────────────────────────────────────────────────

/**
 * Everything a first solve needs: difficulty of the pinned version, whether
 * help made it assisted (a tier-3 hint, the editorial, or an AI helper
 * answer BEFORE the submission was created), the day's daily challenge,
 * active time and topics.
 */
async function loadSolveContext(tx: DbTx, input: SubmissionProgressInput, dayDate: Date): Promise<SolveContext> {
  const { userId, problemId, submittedAt } = input;
  const [version, hint, editorial, aiAssist, daily, activity] = await Promise.all([
    tx.problemVersion.findUniqueOrThrow({
      where: { id: input.problemVersionId },
      select: { difficulty: true, problem: { select: { tags: { select: { topic: true } } } } },
    }),
    tx.hintReveal.findFirst({
      where: { userId, problemId, revealedAt: { lt: submittedAt } },
      orderBy: { tier: "desc" },
      select: { tier: true },
    }),
    tx.editorialView.findUnique({
      where: { userId_problemId: { userId, problemId } },
      select: { firstViewedAt: true },
    }),
    // An answered AI ask before this submission. A failed ask told the
    // student nothing, so it taints nothing.
    tx.aiAssist.findFirst({
      where: { userId, problemId, failed: false, askedAt: { lt: submittedAt } },
      select: { id: true },
    }),
    tx.dailyChallenge.findUnique({ where: { date: dayDate }, select: { problemId: true } }),
    tx.problemActivity.findUnique({
      where: { userId_problemId: { userId, problemId } },
      select: { activeSeconds: true },
    }),
  ]);
  const editorialSeen = editorial !== null && editorial.firstViewedAt.getTime() < submittedAt.getTime();
  const assisted =
    (hint !== null && makesSolveAssisted({ hintTier: hint.tier })) ||
    (editorialSeen && makesSolveAssisted({ editorial: true })) ||
    (aiAssist !== null && makesSolveAssisted({ ai: true }));
  return {
    difficulty: version.difficulty,
    assisted,
    dailyChallenge: daily?.problemId === problemId,
    activeSeconds: activity?.activeSeconds ?? null,
    topics: [...new Set(version.problem.tags.map((t) => t.topic))].sort(),
  };
}

// ── Writes ───────────────────────────────────────────────────────────────

/** Append one XpEvent unless its idempotency key exists. True when this call inserted it. */
async function insertXpEvent(
  tx: DbTx,
  event: {
    userId: string;
    kind: XpEventKind;
    amount: number;
    idempotencyKey: string;
    problemId: string | null;
    submissionId: string;
    occurredAt: Date;
    meta: Prisma.InputJsonObject;
    /** XP_RULES_VERSION, or the super-admin override's version. */
    rulesVersion: number;
  },
): Promise<boolean> {
  const rows = await tx.xpEvent.createManyAndReturn({
    data: [event],
    skipDuplicates: true,
    select: { id: true },
  });
  return rows.length === 1;
}

type Cohort = { batchYear: number | null; departmentCode: string | null; section: string | null };

/** User.lastActiveAt (a counted submission only) and the cohort copied onto the buckets. */
async function touchUser(tx: DbTx, userId: string, plan: ProgressPlan, now: Date): Promise<Cohort> {
  const select = { batchYear: true, departmentCode: true, section: true } as const;
  if (!plan.countAttempt) return tx.user.findUniqueOrThrow({ where: { id: userId }, select });
  return tx.user.update({ where: { id: userId }, data: { lastActiveAt: now }, select });
}

async function upsertProblemStatus(
  tx: DbTx,
  input: SubmissionProgressInput,
  plan: ProgressPlan,
  prior: { firstAttemptAt: Date; lastAttemptAt: Date; status: "ATTEMPTED" | "SOLVED" } | null,
  solve: SolveContext | null,
): Promise<void> {
  const solveFields = solve
    ? {
        status: "SOLVED" as const,
        firstAcceptedAt: input.submittedAt,
        bestSubmissionId: input.submissionId,
        assisted: solve.assisted,
        solvedLanguage: input.language,
        activeSecondsToSolve: solve.activeSeconds,
      }
    : {};
  const window = attemptWindow(prior, input.submittedAt);
  await tx.userProblemStatus.upsert({
    where: { userId_problemId: { userId: input.userId, problemId: input.problemId } },
    create: {
      userId: input.userId,
      problemId: input.problemId,
      status: "ATTEMPTED",
      // A row only ever exists because of a judged submission (a rejudge
      // credit included), so it starts at one attempt.
      attempts: 1,
      failedAttempts: plan.failed ? 1 : 0,
      ...window,
      ...solveFields,
    },
    update: {
      ...(plan.countAttempt
        ? { attempts: { increment: 1 }, failedAttempts: { increment: plan.failed ? 1 : 0 }, ...window }
        : {}),
      ...solveFields,
    },
  });
}

async function upsertActivityDay(
  tx: DbTx,
  userId: string,
  date: Date,
  plan: ProgressPlan,
  xp: { xp: number; xpEasy: number },
): Promise<void> {
  const inc = {
    submissions: plan.countAttempt ? 1 : 0,
    accepted: plan.accepted ? 1 : 0,
    solved: plan.firstSolve ? 1 : 0,
    xp: xp.xp,
    xpEasy: xp.xpEasy,
  };
  await tx.activityDay.upsert({
    where: { userId_date: { userId, date } },
    create: { userId, date, ...inc },
    update: {
      submissions: { increment: inc.submissions },
      accepted: { increment: inc.accepted },
      solved: { increment: inc.solved },
      xp: { increment: inc.xp },
      xpEasy: { increment: inc.xpEasy },
    },
  });
}

async function upsertUserStats(
  tx: DbTx,
  input: SubmissionProgressInput,
  plan: ProgressPlan,
  solve: SolveContext | null,
  solved: { solvedEasy: number; solvedMedium: number; solvedHard: number },
  xp: number,
): Promise<void> {
  const inc = {
    ...solved,
    solvedTotal: plan.firstSolve ? 1 : 0,
    assistedSolves: solve?.assisted ? 1 : 0,
    submissions: plan.countAttempt ? 1 : 0,
    accepted: plan.accepted ? 1 : 0,
    xpTotal: xp,
  };
  // The streak is the one absolute write: advanceStreak() needs the previous
  // state, read above under this user's advisory lock.
  const streak = plan.streak
    ? {
        currentStreak: plan.streak.after.current,
        longestStreak: plan.streak.after.longest,
        lastActiveDate: plan.streak.after.lastActiveDate ? dayAsDate(plan.streak.after.lastActiveDate) : null,
      }
    : {};
  await tx.userStats.upsert({
    where: { userId: input.userId },
    create: { userId: input.userId, ...inc, ...streak },
    update: {
      solvedEasy: { increment: inc.solvedEasy },
      solvedMedium: { increment: inc.solvedMedium },
      solvedHard: { increment: inc.solvedHard },
      solvedTotal: { increment: inc.solvedTotal },
      assistedSolves: { increment: inc.assistedSolves },
      submissions: { increment: inc.submissions },
      accepted: { increment: inc.accepted },
      xpTotal: { increment: inc.xpTotal },
      ...streak,
    },
  });
  if (!solve) return;

  // Per-key JSON counters, incremented atomically in SQL: languageCounts for
  // every first solve; topicSolved (unassisted) or topicAssisted per tag.
  const topicColumn = Prisma.raw(solve.assisted ? `"topicAssisted"` : `"topicSolved"`);
  await tx.$executeRaw`
    UPDATE "UserStats" SET
      "languageCounts" = jsonb_set(
        "languageCounts",
        ARRAY[${input.language}]::text[],
        to_jsonb(COALESCE(("languageCounts" ->> ${input.language})::int, 0) + 1)
      ),
      ${topicColumn} = ${topicColumn} || COALESCE((
        SELECT jsonb_object_agg(t.topic, COALESCE(("UserStats".${topicColumn} ->> t.topic)::int, 0) + 1)
        FROM unnest(${solve.topics}::text[]) AS t(topic)
      ), '{}'::jsonb)
    WHERE "userId" = ${input.userId}`;
}

/** ALL_TIME, MONTH and WEEK buckets: XP and first solves, with the user's cohort for scoped boards. */
async function upsertBuckets(
  tx: DbTx,
  userId: string,
  cohort: Cohort,
  at: Date,
  now: Date,
  xp: number,
  solved: { solvedEasy: number; solvedMedium: number; solvedHard: number },
): Promise<void> {
  for (const { period, periodKey } of bucketKeys(at)) {
    await tx.xpBucket.upsert({
      where: { period_periodKey_userId: { period, periodKey, userId } },
      create: { userId, period, periodKey, xp, ...solved, ...cohort, lastXpAt: now },
      update: {
        xp: { increment: xp },
        solvedEasy: { increment: solved.solvedEasy },
        solvedMedium: { increment: solved.solvedMedium },
        solvedHard: { increment: solved.solvedHard },
        ...cohort,
        // Ties on the boards break by who reached the XP first.
        ...(xp > 0 ? { lastXpAt: now } : {}),
      },
    });
  }
}

/** Every plan this user is enrolled in that contains the problem moves one item on. */
async function advanceStudyPlans(tx: DbTx, userId: string, problemId: string, now: Date): Promise<void> {
  await tx.$executeRaw`
    UPDATE "StudyPlanEnrollment" AS e SET
      "itemsDone" = e."itemsDone" + 1,
      "completedAt" = CASE
        WHEN e."completedAt" IS NULL AND e."itemsDone" + 1 >= e."itemsTotal" THEN ${now}
        ELSE e."completedAt"
      END
    FROM "StudyPlanItem" AS i
    WHERE e."userId" = ${userId}
      AND i."planId" = e."planId"
      AND i."problemId" = ${problemId}
      AND e."itemsDone" < e."itemsTotal"`;
}

/** Award crossed badges once each, with a notification for each badge actually awarded. */
async function awardBadges(tx: DbTx, userId: string, keys: string[], now: Date): Promise<string[]> {
  if (keys.length === 0) return [];
  const catalogue = await tx.badge.findMany({
    where: { key: { in: keys } },
    select: { id: true, key: true, name: true, description: true },
  });
  const missing = keys.filter((key) => !catalogue.some((b) => b.key === key));
  if (missing.length > 0) {
    console.warn(`[progress] badge catalogue has no row for ${missing.join(", ")}; not awarded to user ${userId}`);
  }
  if (catalogue.length === 0) return [];
  const inserted = await tx.userBadge.createManyAndReturn({
    data: catalogue.map((b) => ({ userId, badgeId: b.id, awardedAt: now })),
    skipDuplicates: true,
    select: { badgeId: true },
  });
  const awarded = catalogue.filter((b) => inserted.some((row) => row.badgeId === b.id));
  if (awarded.length > 0) {
    await tx.notification.createMany({
      data: awarded.map((b) => ({
        userId,
        kind: PROGRESS_NOTIFICATION_KIND.badge,
        ...badgeNotification(b),
        link: PROGRESS_NOTIFICATION_LINK,
        createdAt: now,
      })),
    });
  }
  return awarded.map((b) => b.key);
}

/**
 * ProblemStat in ONE atomic statement: counters by increment, and the
 * acceptance rate (accepted / submissions, a 0..1 fraction) recomputed from
 * the incremented values in the same statement — never computed on read.
 */
async function bumpProblemStat(tx: DbTx, problemId: string, plan: ProgressPlan, now: Date): Promise<void> {
  const submissions = plan.countAttempt ? 1 : 0;
  const accepted = plan.accepted ? 1 : 0;
  const attempters = plan.firstAttempt ? 1 : 0;
  const solvers = plan.firstSolve ? 1 : 0;
  if (submissions + accepted + attempters + solvers === 0) return;
  // The first row's rate is computed here: a bound parameter can be folded
  // as a constant at plan time, so a guarded 0 / 0 in SQL could still raise.
  const firstRate = submissions > 0 ? accepted / submissions : 0;
  await tx.$executeRaw`
    INSERT INTO "ProblemStat" ("problemId", "submissions", "accepted", "attempters", "solvers", "acceptanceRate", "updatedAt")
    VALUES (
      ${problemId}, ${submissions}::int, ${accepted}::int, ${attempters}::int, ${solvers}::int,
      ${firstRate}::float8, ${now}
    )
    ON CONFLICT ("problemId") DO UPDATE SET
      "submissions" = "ProblemStat"."submissions" + EXCLUDED."submissions",
      "accepted" = "ProblemStat"."accepted" + EXCLUDED."accepted",
      "attempters" = "ProblemStat"."attempters" + EXCLUDED."attempters",
      "solvers" = "ProblemStat"."solvers" + EXCLUDED."solvers",
      "acceptanceRate" = CASE
        WHEN "ProblemStat"."submissions" + EXCLUDED."submissions" > 0
          THEN ("ProblemStat"."accepted" + EXCLUDED."accepted")::float8
               / ("ProblemStat"."submissions" + EXCLUDED."submissions")
        ELSE 0
      END,
      "updatedAt" = EXCLUDED."updatedAt"`;
}
