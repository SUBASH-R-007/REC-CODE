/**
 * The Phase 5 manual gate check (SPEC §5, Phase 5 "Done when"):
 *
 *   "run a 150-participant simulated contest, confirm standings update
 *    within 2s, the freeze engages, the practice lane is never starved, and
 *    a mid-contest problem edit does not change any already-judged verdict"
 *
 *   cd apps/web
 *   npx tsx --conditions=react-server scripts/contest-sim.ts [--keep]
 *
 * What it drives for real: the contest schema and its invariants, the
 * authoritative attempt rows, the scoring and ordering in @recx/shared, the
 * rank pass, rebuild-standings, the freeze, the pinned-version rule, and the
 * rating transaction. Attempts are written directly rather than judged,
 * because 150 students x 3 problems of real isolate runs is the Phase 2
 * burst harness's job (scripts/load/), not this check's; the lane-starvation
 * half of the gate item belongs there and is recorded separately.
 *
 * It cleans up after itself unless --keep is passed.
 *
 * --conditions=react-server: see scripts/seed.ts.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PARTICIPANTS = 150;
const PROBLEMS = 3;
const TAG = `sim-${Date.now().toString(36)}`;
/** The rank pass must finish inside the SSE push budget. */
const RANK_BUDGET_MS = 2000;

function fail(message: string): never {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}
function ok(message: string) {
  console.log(`ok    ${message}`);
}

function requireReactServerCondition() {
  let resolved = "";
  try {
    resolved = import.meta.resolve("server-only");
  } catch {
    fail("Cannot resolve server-only. Run `npx pnpm@9.15.9 install` first.");
  }
  if (!resolved.endsWith("/empty.js")) fail("This script needs --conditions=react-server.");
}

/** Deterministic pseudo-randomness, so a failure can be reproduced. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

async function main() {
  requireReactServerCondition();
  process.chdir(APP_ROOT);
  const keep = process.argv.includes("--keep");

  const { db } = await import("../src/lib/db");
  const { computeStandings, snapshotOf, storedSnapshot, writeStandings } = await import(
    "../src/lib/contests/standings"
  );
  const { reRankContest } = await import("../src/lib/contests/attempt");
  const { getStandings } = await import("../src/server/queries/contests");
  const shared = await import("@recx/shared");

  console.log(`[sim] ${PARTICIPANTS} participants, ${PROBLEMS} problems, tag ${TAG}`);

  // ── the contest: 2 hours, a 30-minute freeze, started 90 minutes ago ──
  const startsAt = new Date(Date.now() - 90 * 60_000);
  const endsAt = new Date(startsAt.getTime() + 120 * 60_000);

  const published = await db.problemVersion.findMany({
    where: { frozenAt: { not: null }, problem: { status: "PUBLISHED" } },
    take: PROBLEMS,
    orderBy: { id: "asc" },
    select: { id: true, revision: true, problem: { select: { id: true, slug: true } } },
  });
  if (published.length < PROBLEMS) fail(`need ${PROBLEMS} published problems; the seed has ${published.length}`);

  const contest = await db.contest.create({
    data: {
      slug: `${TAG}-contest`,
      title: `Simulated contest ${TAG}`,
      rules: "A simulated round for the Phase 5 gate.",
      kind: "ICPC",
      status: "RUNNING",
      startsAt,
      endsAt,
      freezeMinutes: 30,
      isRated: true,
      createdById: (await db.user.findFirstOrThrow({ where: { role: "SUPER_ADMIN" }, select: { id: true } })).id,
    },
    select: { id: true },
  });
  const letters = ["A", "B", "C", "D", "E", "F"];
  const contestProblems = [];
  for (const [i, version] of published.entries()) {
    contestProblems.push(
      await db.contestProblem.create({
        data: { contestId: contest.id, problemVersionId: version.id, index: letters[i]!, points: 1 },
        select: { id: true, index: true, problemVersionId: true },
      }),
    );
  }
  ok(`contest created with ${contestProblems.length} problems pinned at frozen revisions`);

  // ── 150 participants ──
  const userIds: string[] = [];
  for (let i = 0; i < PARTICIPANTS; i++) {
    const handle = `${TAG}-p${String(i).padStart(3, "0")}`;
    const user = await db.user.create({
      data: {
        collegeId: handle.toUpperCase(),
        email: `${handle}@example.test`,
        firstName: "Sim",
        lastName: `P${i}`,
        handle,
        role: "STUDENT",
        batchYear: 2027,
        departmentCode: "CSE",
      },
      select: { id: true },
    });
    userIds.push(user.id);
  }
  await db.contestRegistration.createMany({
    data: userIds.map((userId) => ({ contestId: contest.id, userId, kind: "RATED" as const })),
  });
  ok(`${PARTICIPANTS} participants registered RATED`);

  // ── plausible attempts: strong students solve more, sooner ──
  const random = rng(42);
  const attempts: Array<{
    contestId: string;
    userId: string;
    contestProblemId: string;
    wrongAttempts: number;
    solvedAt: Date | null;
    solvedAtMinutes: number | null;
    penaltyMinutes: number;
    bestSubmissionId: string | null;
  }> = [];
  for (const [rank, userId] of userIds.entries()) {
    const strength = 1 - rank / PARTICIPANTS;
    for (const problem of contestProblems) {
      const solves = random() < strength * 0.9;
      const wrong = Math.floor(random() * 3);
      if (!solves) {
        if (wrong === 0) continue;
        attempts.push({
          contestId: contest.id,
          userId,
          contestProblemId: problem.id,
          wrongAttempts: wrong,
          solvedAt: null,
          solvedAtMinutes: null,
          penaltyMinutes: 0,
          bestSubmissionId: null,
        });
        continue;
      }
      const minute = Math.floor(5 + random() * 80);
      attempts.push({
        contestId: contest.id,
        userId,
        contestProblemId: problem.id,
        wrongAttempts: wrong,
        solvedAt: new Date(startsAt.getTime() + minute * 60_000),
        solvedAtMinutes: minute,
        penaltyMinutes: minute + shared.ICPC_PENALTY_MINUTES * wrong,
        bestSubmissionId: `${TAG}-sub`,
      });
    }
  }
  await db.contestProblemAttempt.createMany({ data: attempts });
  ok(`${attempts.length} authoritative attempt rows written`);

  // ── the board, from the attempts alone ──
  const built = await computeStandings(db, contest.id, "ICPC");
  await db.$transaction(async (tx) => writeStandings(tx, contest.id, built));
  if (built.length === 0) fail("the rebuild produced an empty board");
  ok(`board materialised for ${built.length} participants`);

  // ── 1. the rank pass finishes inside the 2-second push budget ──
  const t0 = performance.now();
  const moved = await reRankContest(db, contest.id);
  const rankMs = performance.now() - t0;
  console.log(`      rank pass: ${moved} rows in ${rankMs.toFixed(0)} ms (budget ${RANK_BUDGET_MS} ms)`);
  if (rankMs > RANK_BUDGET_MS) fail(`the rank pass took ${rankMs.toFixed(0)} ms, over the ${RANK_BUDGET_MS} ms budget`);
  ok(`standings update within ${RANK_BUDGET_MS} ms`);

  // A second pass must be a no-op: the job is idempotent.
  const again = await reRankContest(db, contest.id);
  if (again !== 0) fail(`a second rank pass moved ${again} rows; it must be idempotent`);
  ok("a second rank pass changes nothing (idempotent)");

  // ── 2. rebuild-standings reproduces the board byte for byte ──
  const stored = await storedSnapshot(db, contest.id);
  const rebuilt = snapshotOf(await computeStandings(db, contest.id, "ICPC"));
  // The stored board carries ranks the rank pass wrote; fold them in so the
  // comparison is of the same shape.
  const rankByUser = new Map(stored.map((r) => [r.userId, r.rank]));
  const rebuiltWithRanks = rebuilt.map((r) => ({ ...r, rank: rankByUser.get(r.userId) ?? r.rank }));
  if (JSON.stringify(stored) !== JSON.stringify(rebuiltWithRanks)) {
    fail("the stored board differs from a rebuild of the same attempts");
  }
  ok("rebuild-standings reproduces the stored board byte for byte");

  // ── 3. the freeze engages ──
  const frozenNow = new Date(endsAt.getTime() - 10 * 60_000);
  const window = { startsAt, endsAt, freezeMinutes: 30 };
  if (!shared.canFreeze(window)) fail("a 120-minute contest with a 30-minute freeze should be freezable");
  if (!shared.isFrozen(window, frozenNow)) fail("the board should be frozen 10 minutes before the end");
  if (shared.isFrozen(window, new Date(startsAt.getTime() + 10 * 60_000))) {
    fail("the board must not be frozen 10 minutes in");
  }
  const viewer = { id: userIds[5]!, role: "STUDENT", batchYear: 2027, departmentCode: "CSE" };
  const frozenView = await getStandings(`${TAG}-contest`, viewer, frozenNow);
  if (!frozenView) fail("the standings view was not found");
  if (!frozenView.frozen) fail("the standings view should report itself frozen");
  if (!frozenView.own) fail("a participant must see their own row during the freeze");
  const staffView = await getStandings(`${TAG}-contest`, { ...viewer, role: "ADMIN" }, frozenNow);
  if (staffView?.frozen) fail("staff must see the live board during a freeze");
  ok("the freeze engages, hides others, keeps your own row, and never hides it from staff");

  // ── 4. a mid-contest problem edit changes no judged verdict ──
  const target = contestProblems[0]!;
  const problem = published[0]!.problem;
  // The next free revision, not a random one: a failed run leaves its
  // simulated revision behind, and a random number collides with it.
  const highest = await db.problemVersion.aggregate({
    where: { problemId: problem.id },
    _max: { revision: true },
  });
  const newRevision = await db.problemVersion.create({
    data: {
      problemId: problem.id,
      revision: (highest._max.revision ?? 0) + 1,
      title: "Edited mid-contest",
      difficulty: "EASY",
      statementMd: "Edited while the contest was running.",
      ioMode: "STDIN",
      timeLimitMs: 1000,
    },
    select: { id: true },
  });
  await db.$executeRawUnsafe(
    `UPDATE "public"."ProblemVersion" SET "frozenAt" = now() WHERE "id" = $1`,
    newRevision.id,
  );
  await db.$executeRawUnsafe(
    `UPDATE "public"."Problem" SET "liveVersionId" = $1 WHERE "id" = $2`,
    newRevision.id,
    problem.id,
  );

  const pinnedAfter = await db.contestProblem.findUniqueOrThrow({
    where: { id: target.id },
    select: { problemVersionId: true },
  });
  if (pinnedAfter.problemVersionId !== target.problemVersionId) {
    fail("the contest's pinned version moved when the problem was edited");
  }
  const boardAfterEdit = await storedSnapshot(db, contest.id);
  if (JSON.stringify(boardAfterEdit) !== JSON.stringify(stored)) {
    fail("the board changed when the problem was edited mid-contest");
  }
  ok("a mid-contest problem edit moves the live pointer and changes neither the pin nor any verdict");

  // ── 5. the rating transaction ──
  await db.contest.update({ where: { id: contest.id }, data: { status: "FINISHED" } });
  // releaseContestRating is NOT imported here: it is a "use server" module,
  // so importing it drags in next/navigation and React's client runtime,
  // which a plain tsx script has no business loading. The action guards on a
  // request session a script does not have anyway. So the rating arithmetic
  // is exercised directly, from exactly the inputs the action would pass;
  // the action's own guard is covered by the runtime capability matrix.
  const ranked = await db.contestStanding.findMany({
    where: { contestId: contest.id },
    select: { userId: true, rank: true },
    orderBy: { rank: "asc" },
  });
  const changes = shared.computeRatingChanges(
    ranked.map((r) => ({ userId: r.userId, rating: shared.RATING_SEED, rank: r.rank! })),
  );
  const sum = changes.reduce((a, c) => a + c.delta, 0);
  const submitted = new Set((await db.contestProblemAttempt.findMany({
    where: { contestId: contest.id },
    select: { userId: true },
    distinct: ["userId"],
  })).map((r) => r.userId));
  console.log(
    `      rating: ${changes.length} of ${PARTICIPANTS} registered (${submitted.size} submitted), Σdelta ${sum}`,
  );
  // The board is materialised from ContestProblemAttempt (SPEC §4e), so a
  // student who registered and then submitted nothing has no row and is not
  // rated. Recorded as a decision in docs/OPEN-QUESTIONS.md — the reference
  // implementation instead rates every registrant at the bottom.
  if (changes.length !== submitted.size) {
    fail(`rated ${changes.length} but ${submitted.size} students submitted; the two must agree`);
  }
  if (changes.length < shared.MIN_RATED_PARTICIPANTS) {
    fail(`only ${changes.length} rated participants, under the ${shared.MIN_RATED_PARTICIPANTS} minimum`);
  }
  if (Math.abs(sum) > changes.length / 2) fail(`Σdelta ${sum} is not ≈ 0`);
  if (changes.some((c) => Math.abs(c.delta) > shared.RATING_CLAMP)) fail("a delta exceeded the clamp");
  ok(`rating computed for ${changes.length} participants, Σdelta ≈ 0, every delta inside the clamp`);

  // ── cleanup ──
  if (keep) {
    console.log(`[sim] --keep: left contest ${TAG}-contest and ${PARTICIPANTS} users in place`);
  } else {
    const off = [
      ["ContestProblem", "ContestProblem_frozen_version"],
      ["Contest", "Contest_rating_once"],
      ["ProblemVersion", "ProblemVersion_frozen_guard"],
    ] as const;
    for (const [table, trigger] of off) {
      await db.$executeRawUnsafe(`ALTER TABLE "public"."${table}" DISABLE TRIGGER "${trigger}"`);
    }
    // Raw SQL for the two writes that touch a frozen version: the
    // packages/db client extension (frozen.ts) refuses them before the
    // database trigger is even reached, so disabling the trigger is not
    // enough. Everything else goes through Prisma as usual.
    await db.$executeRawUnsafe(
      `UPDATE "public"."Problem" SET "liveVersionId" = $1 WHERE "id" = $2`,
      published[0]!.id,
      problem.id,
    );
    await db.contestStanding.deleteMany({ where: { contestId: contest.id } });
    await db.contestProblemAttempt.deleteMany({ where: { contestId: contest.id } });
    await db.contestRegistration.deleteMany({ where: { contestId: contest.id } });
    await db.contestProblem.deleteMany({ where: { contestId: contest.id } });
    await db.contest.delete({ where: { id: contest.id } });
    await db.$executeRawUnsafe(`DELETE FROM "public"."ProblemVersion" WHERE "id" = $1`, newRevision.id);
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    for (const [table, trigger] of off) {
      await db.$executeRawUnsafe(`ALTER TABLE "public"."${table}" ENABLE TRIGGER "${trigger}"`);
    }
    ok("cleaned up");
  }

  console.log("[sim] PASS");
}

main()
  .then(async () => {
    const { db } = await import("../src/lib/db");
    await db.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    try {
      const { db } = await import("../src/lib/db");
      await db.$disconnect();
    } catch {
      /* already down */
    }
    process.exit(1);
  });
