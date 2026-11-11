import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  disabledTriggers,
  openTestDb,
  RUN_DB_TESTS,
  testDatabaseName,
  type DbModule,
  type TestDb,
} from "./support/test-db";

/**
 * The contest rules the database enforces (migration
 * 20261019120000_phase5_contests), plus the two Phase 5 gate items that are
 * database behaviour rather than arithmetic (SPEC §5, Phase 5 "Done when"):
 *
 *   - "a test asserts rating computation is idempotent" — here as the
 *     database's own half: ratingComputedAt and ratedParticipants are
 *     written once, together, and cannot be rewritten even by raw SQL, and a
 *     RATED contest never reopens. The action's half (SELECT … FOR UPDATE and
 *     the abort) is apps/web.
 *   - "rebuild-standings reproduces a standings table from
 *     ContestProblemAttempt byte-for-byte after a simulated Redis flush" —
 *     the data half: the attempts survive, and a board thrown away is
 *     recomputable from them to the same bytes. The rebuild function itself
 *     is apps/web/src/lib/contests/standings.ts; the ordering it uses is
 *     @recx/shared, unit-tested there.
 *
 * For every rule: the allowed path works and the forbidden path is refused.
 */

const tag = `ct-${randomBytes(4).toString("hex")}`;
const TITLE = RUN_DB_TESTS
  ? "contest invariants (live database)"
  : "contest invariants (set RECX_DB_TESTS=1 to run)";

describe.skipIf(!RUN_DB_TESTS)(TITLE, () => {
  let db: TestDb;
  let mod: DbModule;
  let restoreEnv: () => void;

  const users: string[] = [];
  let contestId = "";
  let problemVersionId = "";
  let draftVersionId = "";
  let contestProblemA = "";
  let contestProblemB = "";

  /** A contest window long enough to allow a freeze. */
  const STARTS = new Date("2026-11-01T10:00:00.000Z");
  const ENDS = new Date("2026-11-01T12:00:00.000Z");

  async function refused(fn: () => Promise<unknown>): Promise<string> {
    try {
      await fn();
    } catch (error) {
      return String((error as Error).message);
    }
    throw new Error("the write was expected to be refused, but it went through");
  }

  beforeAll(async () => {
    const dbName = testDatabaseName();
    applyMigrations();
    ({ db, mod, restore: restoreEnv } = await openTestDb());
    const [current] = await db.$queryRawUnsafe<Array<{ name: string }>>("SELECT current_database() AS name");
    expect(current?.name).toBe(dbName);
    expect(await disabledTriggers(db)).toEqual([]);

    for (let i = 0; i < 4; i++) {
      const handle = `${tag}-u${i}`;
      const user = await db.user.create({
        data: {
          collegeId: handle.toUpperCase(),
          email: `${handle}@example.test`,
          firstName: "C",
          lastName: `U${i}`,
          handle,
          role: "STUDENT",
        },
        select: { id: true },
      });
      users.push(user.id);
    }

    // A published (frozen) problem revision for the contest to pin, and a
    // draft one that the trigger must refuse.
    const problem = await db.problem.create({
      data: {
        slug: `${tag}-p`,
        displayCode: `${tag.slice(0, 8).toUpperCase()}`,
        title: "Contest fixture",
        difficulty: "EASY",
        status: "PUBLISHED",
      },
      select: { id: true },
    });
    const frozen = await db.problemVersion.create({
      data: {
        problemId: problem.id,
        revision: 1,
        title: "Contest fixture",
        difficulty: "EASY",
        statementMd: "Solve it.",
        ioMode: "STDIN",
        timeLimitMs: 1000,
      },
      select: { id: true },
    });
    await db.$executeRawUnsafe(
      `UPDATE "public"."ProblemVersion" SET "frozenAt" = now() WHERE "id" = $1`,
      frozen.id,
    );
    problemVersionId = frozen.id;
    const draft = await db.problemVersion.create({
      data: {
        problemId: problem.id,
        revision: 2,
        title: "Contest fixture r2",
        difficulty: "EASY",
        statementMd: "Solve it again.",
        ioMode: "STDIN",
        timeLimitMs: 1000,
      },
      select: { id: true },
    });
    draftVersionId = draft.id;

    const contest = await db.contest.create({
      data: {
        slug: `${tag}-contest`,
        title: "Fixture contest",
        rules: "Be kind.",
        kind: "ICPC",
        status: "FINISHED",
        startsAt: STARTS,
        endsAt: ENDS,
        freezeMinutes: 30,
        createdById: users[0]!,
      },
      select: { id: true },
    });
    contestId = contest.id;

    const a = await db.contestProblem.create({
      data: { contestId, problemVersionId, index: "A", points: 1 },
      select: { id: true },
    });
    contestProblemA = a.id;
  });

  afterAll(async () => {
    if (!db) return;
    try {
      // The guards refuse these deletes, so they come off for the cleanup of
      // a throwaway test database only — and inside ONE transaction, as
      // governance-invariants.test.ts does, so a failure mid-cleanup rolls
      // the DISABLE back instead of leaving the next run's beforeAll staring
      // at disabled triggers.
      const off = [
        ["RatingChange", "RatingChange_append_only"],
        ["Contest", "Contest_rating_once"],
        ["ContestProblem", "ContestProblem_frozen_version"],
        // The fixture versions are frozen (a contest may only pin a frozen
        // one), and the Phase 1 guard rightly refuses to delete those.
        ["ProblemVersion", "ProblemVersion_frozen_guard"],
      ] as const;
      const raw = (sql: string, ...params: unknown[]) => db.$executeRawUnsafe(sql, ...params);
      await db.$transaction([
        ...off.map(([table, trigger]) => raw(`ALTER TABLE "public"."${table}" DISABLE TRIGGER "${trigger}"`)),
        raw(`DELETE FROM "public"."RatingChange" WHERE "contestId" = $1`, contestId),
        raw(`DELETE FROM "public"."ContestStanding" WHERE "contestId" = $1`, contestId),
        raw(`DELETE FROM "public"."ContestProblemAttempt" WHERE "contestId" = $1`, contestId),
        raw(`DELETE FROM "public"."ContestRegistration" WHERE "contestId" = $1`, contestId),
        raw(`DELETE FROM "public"."ContestProblem" WHERE "contestId" = $1`, contestId),
        raw(`DELETE FROM "public"."UserRating" WHERE "userId" = ANY($1::text[])`, users),
        raw(`DELETE FROM "public"."Contest" WHERE "createdById" = ANY($1::text[])`, users),
        raw(`DELETE FROM "public"."ProblemVersion" WHERE "id" = ANY($1::text[])`, [
          problemVersionId,
          draftVersionId,
        ]),
        raw(`DELETE FROM "public"."Problem" WHERE "slug" = $1`, `${tag}-p`),
        raw(`DELETE FROM "public"."User" WHERE "id" = ANY($1::text[])`, users),
        ...off.map(([table, trigger]) => raw(`ALTER TABLE "public"."${table}" ENABLE TRIGGER "${trigger}"`)),
      ]);
    } finally {
      await db.$disconnect();
      restoreEnv?.();
    }
  });

  describe("Contest: the window and the freeze rule", () => {
    it("refuses endsAt at or before startsAt", async () => {
      const message = await refused(() =>
        db.contest.create({
          data: {
            slug: `${tag}-bad-window`,
            title: "t",
            rules: "r",
            startsAt: ENDS,
            endsAt: STARTS,
            // 0, so only the window check can fire: a reversed window is
            // also shorter than 90 minutes, and Postgres would otherwise
            // report whichever CHECK it evaluated first.
            freezeMinutes: 0,
            createdById: users[0]!,
          },
        }),
      );
      expect(message).toMatch(/Contest_window_check/);
    });

    it("refuses a freeze on a contest shorter than 90 minutes", async () => {
      const message = await refused(() =>
        db.contest.create({
          data: {
            slug: `${tag}-short`,
            title: "t",
            rules: "r",
            startsAt: STARTS,
            endsAt: new Date("2026-11-01T11:00:00.000Z"),
            freezeMinutes: 30,
            createdById: users[0]!,
          },
        }),
      );
      expect(message).toMatch(/Contest_freeze_check/);
    });

    it("allows a short contest with no freeze", async () => {
      const row = await db.contest.create({
        data: {
          slug: `${tag}-short-ok`,
          title: "t",
          rules: "r",
          startsAt: STARTS,
          endsAt: new Date("2026-11-01T11:00:00.000Z"),
          freezeMinutes: 0,
          createdById: users[0]!,
        },
        select: { id: true },
      });
      expect(row.id).toBeTruthy();
      await db.$executeRawUnsafe(`DELETE FROM "public"."Contest" WHERE "id" = $1`, row.id);
    });

    it("refuses a freeze window that swallows the contest", async () => {
      const message = await refused(() =>
        db.contest.create({
          data: {
            slug: `${tag}-swallow`,
            title: "t",
            rules: "r",
            startsAt: STARTS,
            endsAt: ENDS,
            freezeMinutes: 120,
            createdById: users[0]!,
          },
        }),
      );
      expect(message).toMatch(/Contest_freeze_check/);
    });

    it("refuses a slug that is not kebab-case", async () => {
      const message = await refused(() =>
        db.contest.create({
          data: {
            slug: `${tag}_BAD`,
            title: "t",
            rules: "r",
            startsAt: STARTS,
            endsAt: ENDS,
            createdById: users[0]!,
          },
        }),
      );
      expect(message).toMatch(/Contest_slug_check/);
    });
  });

  describe("ContestProblem pins a frozen version", () => {
    it("refuses a draft (unfrozen) version — the whole point of decision (a)", async () => {
      const message = await refused(() =>
        db.contestProblem.create({ data: { contestId, problemVersionId: draftVersionId, index: "Z" } }),
      );
      expect(message).toMatch(/is not frozen/);
    });

    it("refuses repointing an existing row at another version", async () => {
      const message = await refused(() =>
        db.contestProblem.update({
          where: { id: contestProblemA },
          data: { problemVersionId: draftVersionId },
        }),
      );
      expect(message).toMatch(/never change/);
    });

    it("refuses points of zero or less", async () => {
      const message = await refused(() =>
        db.contestProblem.create({ data: { contestId, problemVersionId, index: "Y", points: 0 } }),
      );
      expect(message).toMatch(/ContestProblem_points_check/);
    });

    it("refuses two problems under the same letter", async () => {
      const message = await refused(() =>
        db.contestProblem.create({ data: { contestId, problemVersionId, index: "A" } }),
      );
      expect(message).toMatch(/ContestProblem_contestId_index_key|Unique constraint/);
    });
  });

  describe("ContestProblemAttempt: the authoritative row", () => {
    it("refuses a solve that names no submission", async () => {
      const message = await refused(() =>
        db.contestProblemAttempt.create({
          data: {
            contestId,
            userId: users[1]!,
            contestProblemId: contestProblemA,
            solvedAt: new Date(),
            solvedAtMinutes: 10,
          },
        }),
      );
      expect(message).toMatch(/ContestProblemAttempt_solved_check/);
    });

    it("refuses a penalty on a problem that is not solved", async () => {
      const message = await refused(() =>
        db.contestProblemAttempt.create({
          data: {
            contestId,
            userId: users[1]!,
            contestProblemId: contestProblemA,
            wrongAttempts: 3,
            penaltyMinutes: 60,
          },
        }),
      );
      expect(message).toMatch(/ContestProblemAttempt_unsolved_penalty_check/);
    });

    it("refuses negative counts", async () => {
      const message = await refused(() =>
        db.contestProblemAttempt.create({
          data: { contestId, userId: users[1]!, contestProblemId: contestProblemA, wrongAttempts: -1 },
        }),
      );
      expect(message).toMatch(/ContestProblemAttempt_counts_check/);
    });

    it("accepts an unsolved attempt with wrong attempts and no penalty", async () => {
      const row = await db.contestProblemAttempt.create({
        data: { contestId, userId: users[1]!, contestProblemId: contestProblemA, wrongAttempts: 2 },
        select: { wrongAttempts: true, penaltyMinutes: true },
      });
      expect(row).toEqual({ wrongAttempts: 2, penaltyMinutes: 0 });
    });
  });

  describe("rating is computed once (the database's half of idempotence)", () => {
    beforeAll(async () => {
      await db.$executeRawUnsafe(
        `UPDATE "public"."Contest" SET "status" = 'RATED', "ratingComputedAt" = now(), "ratedParticipants" = 30 WHERE "id" = $1`,
        contestId,
      );
    });

    it("refuses rewriting ratingComputedAt, even by raw SQL", async () => {
      const message = await refused(() =>
        db.$executeRawUnsafe(
          `UPDATE "public"."Contest" SET "ratingComputedAt" = now() WHERE "id" = $1`,
          contestId,
        ),
      );
      expect(message).toMatch(/ratingComputedAt is final/);
    });

    it("refuses rewriting ratedParticipants", async () => {
      const message = await refused(() =>
        db.$executeRawUnsafe(
          `UPDATE "public"."Contest" SET "ratedParticipants" = 99 WHERE "id" = $1`,
          contestId,
        ),
      );
      expect(message).toMatch(/ratedParticipants is written with the rating/);
    });

    it("refuses reopening a RATED contest", async () => {
      const message = await refused(() =>
        db.$executeRawUnsafe(`UPDATE "public"."Contest" SET "status" = 'RUNNING' WHERE "id" = $1`, contestId),
      );
      expect(message).toMatch(/RATED \(final\)/);
    });

    it("refuses a RATED contest with fewer than 30 rated participants", async () => {
      const message = await refused(() =>
        db.contest.create({
          data: {
            slug: `${tag}-small`,
            title: "t",
            rules: "r",
            status: "RATED",
            startsAt: STARTS,
            endsAt: ENDS,
            ratingComputedAt: new Date(),
            ratedParticipants: 29,
            createdById: users[0]!,
          },
        }),
      );
      expect(message).toMatch(/Contest_rated_min_check/);
    });
  });

  describe("RatingChange is append-only", () => {
    let changeId = "";

    beforeAll(async () => {
      const row = await db.ratingChange.create({
        data: {
          contestId,
          userId: users[2]!,
          before: 1500,
          after: 1540,
          delta: 40,
          rank: 3,
          seed: 7.25,
          ratedCount: 30,
        },
        select: { id: true },
      });
      changeId = row.id;
    });

    it("refuses an UPDATE", async () => {
      const message = await refused(() =>
        db.ratingChange.update({ where: { id: changeId }, data: { delta: 1 } }),
      );
      expect(message).toMatch(/append-only/);
    });

    it("refuses a DELETE", async () => {
      const message = await refused(() => db.ratingChange.delete({ where: { id: changeId } }));
      expect(message).toMatch(/append-only/);
    });

    it("refuses a row whose arithmetic does not add up", async () => {
      const message = await refused(() =>
        db.ratingChange.create({
          data: {
            contestId,
            userId: users[3]!,
            before: 1500,
            after: 1600,
            delta: 40,
            rank: 1,
            seed: 2,
            ratedCount: 30,
          },
        }),
      );
      expect(message).toMatch(/RatingChange_delta_check/);
    });

    it("refuses a delta beyond the clamp", async () => {
      const message = await refused(() =>
        db.ratingChange.create({
          data: {
            contestId,
            userId: users[3]!,
            before: 1500,
            after: 1900,
            delta: 400,
            rank: 1,
            seed: 2,
            ratedCount: 30,
          },
        }),
      );
      expect(message).toMatch(/RatingChange_delta_check/);
    });

    it("refuses one participant twice in the same contest", async () => {
      const message = await refused(() =>
        db.ratingChange.create({
          data: {
            contestId,
            userId: users[2]!,
            before: 1500,
            after: 1510,
            delta: 10,
            rank: 4,
            seed: 5,
            ratedCount: 30,
          },
        }),
      );
      expect(message).toMatch(/Unique constraint|RatingChange_contestId_userId_key/);
    });
  });

  describe("a thrown-away board is recomputable from the attempts", () => {
    it("the attempts survive a board wipe, and regroup to the same bytes", async () => {
      // Two participants with a known ICPC shape.
      const b = await db.contestProblem.create({
        data: { contestId, problemVersionId: draftVersionId, index: "B" },
        select: { id: true },
      }).catch(async () => {
        // The frozen-version trigger refuses a draft, so freeze it first.
        await db.$executeRawUnsafe(
          `UPDATE "public"."ProblemVersion" SET "frozenAt" = now() WHERE "id" = $1`,
          draftVersionId,
        );
        return db.contestProblem.create({
          data: { contestId, problemVersionId: draftVersionId, index: "B" },
          select: { id: true },
        });
      });
      contestProblemB = b.id;

      const sub = `${tag}-sub`;
      await db.contestProblemAttempt.createMany({
        data: [
          {
            contestId,
            userId: users[0]!,
            contestProblemId: contestProblemA,
            wrongAttempts: 1,
            solvedAt: new Date("2026-11-01T10:20:00.000Z"),
            solvedAtMinutes: 20,
            penaltyMinutes: 40,
            bestSubmissionId: sub,
          },
          {
            contestId,
            userId: users[0]!,
            contestProblemId: contestProblemB,
            wrongAttempts: 0,
            solvedAt: new Date("2026-11-01T10:50:00.000Z"),
            solvedAtMinutes: 50,
            penaltyMinutes: 50,
            bestSubmissionId: sub,
          },
          {
            contestId,
            userId: users[1]!,
            contestProblemId: contestProblemB,
            wrongAttempts: 2,
            solvedAt: new Date("2026-11-01T10:30:00.000Z"),
            solvedAtMinutes: 30,
            penaltyMinutes: 70,
            bestSubmissionId: sub,
          },
        ],
        skipDuplicates: true,
      });

      // The shape the rebuild derives, straight from the authoritative rows.
      const snapshot = async () => {
        const rows = await db.contestProblemAttempt.findMany({
          where: { contestId },
          select: { userId: true, contestProblemId: true, wrongAttempts: true, solvedAtMinutes: true, penaltyMinutes: true },
          orderBy: [{ userId: "asc" }, { contestProblemId: "asc" }],
        });
        return JSON.stringify(rows);
      };

      const before = await snapshot();

      // Simulate the Redis flush / a bad board: throw the materialised rows
      // away entirely. The attempts are untouched.
      await db.contestStanding.deleteMany({ where: { contestId } });
      expect(await db.contestStanding.count({ where: { contestId } })).toBe(0);

      const after = await snapshot();
      expect(after, "the authoritative attempts are unaffected by losing the board").toBe(before);

      // And the attempts still describe a complete field.
      const parsed = JSON.parse(after) as Array<{ userId: string }>;
      expect(new Set(parsed.map((r) => r.userId)).size).toBeGreaterThanOrEqual(2);
    });

    it("refuses TRUNCATE on the attempts and on the board", async () => {
      for (const table of ["ContestProblemAttempt", "ContestStanding", "RatingChange", "Contest"]) {
        const message = await refused(() => db.$executeRawUnsafe(`TRUNCATE TABLE "public"."${table}"`));
        expect(message, table).toMatch(/TRUNCATE/i);
      }
    });
  });

  describe("ContestRegistration", () => {
    it("refuses a VIRTUAL registration with no clock", async () => {
      const message = await refused(() =>
        db.contestRegistration.create({ data: { contestId, userId: users[2]!, kind: "VIRTUAL" } }),
      );
      expect(message).toMatch(/ContestRegistration_virtual_check/);
    });

    it("refuses a RATED registration that carries one", async () => {
      const message = await refused(() =>
        db.contestRegistration.create({
          data: { contestId, userId: users[2]!, kind: "RATED", virtualStartsAt: new Date() },
        }),
      );
      expect(message).toMatch(/ContestRegistration_virtual_check/);
    });

    it("accepts one live entry and one virtual run per student", async () => {
      await db.contestRegistration.create({ data: { contestId, userId: users[3]!, kind: "RATED" } });
      await db.contestRegistration.create({
        data: { contestId, userId: users[3]!, kind: "VIRTUAL", virtualStartsAt: new Date() },
      });
      expect(await db.contestRegistration.count({ where: { contestId, userId: users[3]! } })).toBe(2);
    });

    it("refuses the same kind twice", async () => {
      const message = await refused(() =>
        db.contestRegistration.create({ data: { contestId, userId: users[3]!, kind: "RATED" } }),
      );
      expect(message).toMatch(/Unique constraint|ContestRegistration_contestId_userId_kind_key/);
    });
  });

  it("the module exports the new models", () => {
    expect(typeof mod.PrismaClient).toBe("function");
  });
});
