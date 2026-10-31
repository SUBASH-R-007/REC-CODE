import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The recommender's candidate gathering against the real tables
 * (Phase 12f).
 *
 * The rule engine is pure and tested in @recx/shared. What cannot be
 * tested there is the half that reads: whether a due revision card is
 * found, whether a drive's company is matched to the tags the interview
 * archive produced, whether the weakest topic is computed from UNASSISTED
 * solves, and whether the rotation window counts problems rather than
 * submissions. Each of those is a `where` clause, and a `where` clause is
 * exactly what a unit test cannot check.
 *
 * Opt-in: RECX_DB_TESTS=1.
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";

vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";
  }
});

describe.skipIf(!ENABLED)("the recommender's candidates against recx_test", () => {
  const tag = `rec-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let db: import("@recx/db").Db;
  let extras: typeof import("@/server/queries/recommend");
  let userId = "";
  let companyId = "";
  let languageConfigId = "";
  const problems: Record<string, { id: string; versionId: string }> = {};

  async function problem(name: string, topic: string, status: "PUBLISHED" | "DRAFT" = "PUBLISHED") {
    const row = await db.problem.create({
      data: {
        slug: `${tag}-${name}`,
        displayCode: `${tag}-${name}`.toUpperCase(),
        title: `Recommend ${name}`,
        difficulty: "EASY",
        status,
        tags: { create: [{ topic: topic as never }] },
      },
      select: { id: true },
    });
    const version = await db.problemVersion.create({
      data: {
        problemId: row.id,
        revision: 1,
        title: `Recommend ${name}`,
        difficulty: "EASY",
        statementMd: "Test.",
        ioMode: "STDIN",
        timeLimitMs: 1000,
      },
      select: { id: true },
    });
    if (status === "PUBLISHED") {
      await db.problem.update({ where: { id: row.id }, data: { liveVersionId: version.id } });
    }
    problems[name] = { id: row.id, versionId: version.id };
    return problems[name]!;
  }

  async function solve(name: string, options: { assisted?: boolean } = {}) {
    await db.userProblemStatus.create({
      data: {
        userId,
        problemId: problems[name]!.id,
        status: "SOLVED",
        assisted: options.assisted ?? false,
        attempts: 1,
        failedAttempts: 0,
        firstAttemptAt: new Date(),
        lastAttemptAt: new Date(),
        firstAcceptedAt: new Date(),
      },
    });
  }

  async function submit(name: string, createdAt: Date) {
    await db.submission.create({
      data: {
        userId,
        problemId: problems[name]!.id,
        problemVersionId: problems[name]!.versionId,
        languageConfigId,
        language: "cpp20",
        origin: "PRACTICE",
        lane: "PRACTICE",
        status: "DONE",
        judgeState: "DONE",
        verdict: "AC",
        sourceSha256: "0".repeat(64),
        sourceBytes: 1,
        createdAt,
        judgedAt: createdAt,
      },
    });
  }

  beforeAll(async () => {
    const { createPrismaClient } = await import("@recx/db");
    const { LANGUAGE_CATALOG } = await import("@recx/shared");
    db = createPrismaClient({
      url: process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test",
      log: [],
    });
    extras = await import("@/server/queries/recommend");

    const rt = LANGUAGE_CATALOG.cpp20;
    languageConfigId = (
      await db.languageConfig.upsert({
        where: { key_toolchainId: { key: "cpp20", toolchainId: rt.toolchainId } },
        create: {
          key: "cpp20",
          toolchainId: rt.toolchainId,
          label: rt.label,
          version: rt.version,
          runtime: JSON.parse(JSON.stringify(rt)),
          enabled: true,
          isCurrent: true,
        },
        update: {},
        select: { id: true },
      })
    ).id;

    userId = (
      await db.user.create({
        data: {
          collegeId: `${tag}-s`,
          email: `${tag}@rec-code.example`,
          firstName: "A",
          lastName: "Student",
          handle: `${tag}-s`,
          batchYear: 2027,
          departmentCode: "CSE",
        },
        select: { id: true },
      })
    ).id;

    companyId = (
      await db.company.create({ data: { slug: `${tag}-co`, name: `Company ${tag}`, curated: false }, select: { id: true } })
    ).id;

    await problem("asked", "GRAPHS");
    await problem("asked-solved", "GRAPHS");
    await problem("draft-asked", "GRAPHS", "DRAFT");
    await problem("revise", "TREES");
    await problem("arrays-a", "ARRAYS_HASHING");
    await problem("arrays-b", "ARRAYS_HASHING");
    await problem("arrays-c", "ARRAYS_HASHING");
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    try {
      const ids = Object.values(problems).map((p) => p.id);
      await db.submission.deleteMany({ where: { userId } });
      await db.revisionCard.deleteMany({ where: { userId } });
      await db.userProblemStatus.deleteMany({ where: { userId } });
      await db.problemCompanyTag.deleteMany({ where: { companyId } });
      await db.placementDrive.deleteMany({ where: { companyId } });
      await db.problemTag.deleteMany({ where: { problemId: { in: ids } } });
      await db.problemVersion.updateMany({ where: { problemId: { in: ids } }, data: {} });
      await db.problem.updateMany({ where: { id: { in: ids } }, data: { liveVersionId: null } });
      await db.problemVersion.deleteMany({ where: { problemId: { in: ids } } });
      await db.problem.deleteMany({ where: { id: { in: ids } } });
      await db.company.deleteMany({ where: { id: companyId } });
      await db.user.deleteMany({ where: { id: userId } });
    } finally {
      await db.$disconnect();
    }
  }, 60_000);

  it("finds nothing when there is nothing", async () => {
    const found = await extras.loadRecommendExtras(userId);
    expect(found.revision).toBeNull();
    expect(found.drive).toBeNull();
    expect(found.recentTopics).toEqual([]);
    // Every topic is below the PRODUCT target, so the weakest three are offered.
    expect(found.weakTopics).toHaveLength(3);
    expect(found.weakTopics[0]).toMatchObject({ have: 0, target: 4 });
  });

  it("finds a due revision card, and ignores one that is not due", async () => {
    const today = new Date(`${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date())}T00:00:00.000Z`);
    await db.revisionCard.create({
      data: { userId, problemId: problems.revise!.id, stage: 2, dueOn: new Date(today.getTime() - 3 * 86_400_000) },
    });
    const due = await extras.loadRecommendExtras(userId);
    expect(due.revision).toMatchObject({ overdueDays: 3, stepDays: 7 });
    expect(due.revision!.problem.slug).toBe(`${tag}-revise`);

    await db.revisionCard.update({
      where: { userId_problemId: { userId, problemId: problems.revise!.id } },
      data: { dueOn: new Date(today.getTime() + 5 * 86_400_000) },
    });
    expect((await extras.loadRecommendExtras(userId)).revision).toBeNull();
  });

  it("ignores a learned card, however overdue", async () => {
    const today = new Date(`${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date())}T00:00:00.000Z`);
    await db.revisionCard.update({
      where: { userId_problemId: { userId, problemId: problems.revise!.id } },
      data: { dueOn: new Date(today.getTime() - 60 * 86_400_000), stage: 4, reviews: 5, lastReviewAt: new Date(), learnedAt: new Date() },
    });
    expect((await extras.loadRecommendExtras(userId)).revision).toBeNull();
    await db.revisionCard.delete({ where: { userId_problemId: { userId, problemId: problems.revise!.id } } });
  });

  describe("the drive rung", () => {
    beforeAll(async () => {
      const today = new Date(`${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date())}T00:00:00.000Z`);
      await db.placementDrive.create({
        data: {
          companyId,
          companyName: `Company ${tag}`,
          tier: "PRODUCT",
          driveOn: new Date(today.getTime() + 6 * 86_400_000),
          eligibleDepartmentCodes: [],
          createdById: userId,
        },
      });
      // Reported twice for one problem, once for another, and on a draft.
      await db.problemCompanyTag.createMany({
        data: [
          { problemId: problems.asked!.id, companyId, frequency: 2, source: "EXPERIENCE" },
          { problemId: problems["asked-solved"]!.id, companyId, frequency: 9, source: "EXPERIENCE" },
          { problemId: problems["draft-asked"]!.id, companyId, frequency: 99, source: "EXPERIENCE" },
        ],
      });
      await solve("asked-solved");
    });

    it("picks the most-asked problem the student has NOT solved, and never a draft", async () => {
      const found = await extras.loadRecommendExtras(userId);
      expect(found.drive).toMatchObject({ companyName: `Company ${tag}`, daysAway: 6, askedCount: 2 });
      // Not the frequency-9 one (solved) and not the frequency-99 one (draft).
      expect(found.drive!.problem.slug).toBe(`${tag}-asked`);
    });

    it("ignores a drive outside the horizon, and an archived one", async () => {
      const today = new Date(`${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date())}T00:00:00.000Z`);
      await db.placementDrive.updateMany({
        where: { companyId },
        data: { driveOn: new Date(today.getTime() + 90 * 86_400_000) },
      });
      expect((await extras.loadRecommendExtras(userId)).drive).toBeNull();

      await db.placementDrive.updateMany({
        where: { companyId },
        data: { driveOn: new Date(today.getTime() + 3 * 86_400_000), archivedAt: new Date() },
      });
      expect((await extras.loadRecommendExtras(userId)).drive).toBeNull();

      await db.placementDrive.updateMany({ where: { companyId }, data: { archivedAt: null } });
    });

    it("ignores a drive for another batch, and one for another department", async () => {
      await db.placementDrive.updateMany({ where: { companyId }, data: { eligibleBatchYear: 1999 } });
      expect((await extras.loadRecommendExtras(userId)).drive).toBeNull();

      await db.placementDrive.updateMany({
        where: { companyId },
        data: { eligibleBatchYear: null, eligibleDepartmentCodes: ["MECH"] },
      });
      expect((await extras.loadRecommendExtras(userId)).drive).toBeNull();

      await db.placementDrive.updateMany({ where: { companyId }, data: { eligibleDepartmentCodes: ["CSE"] } });
      expect((await extras.loadRecommendExtras(userId)).drive).not.toBeNull();
    });
  });

  describe("the weakest topic, and rotation", () => {
    it("counts only UNASSISTED solves", async () => {
      // Two array solves, one of them assisted: arrays counts ONE.
      await solve("arrays-a");
      await solve("arrays-b", { assisted: true });
      const found = await extras.loadRecommendExtras(userId);
      const arrays = found.weakTopics.find((row) => row.topic === "ARRAYS_HASHING");
      // Arrays is no longer among the three weakest (every other topic has
      // zero), which is itself the assertion that it counted something.
      expect(arrays ?? { have: 1 }).toMatchObject({ have: 1 });
      expect(found.weakTopics.every((row) => row.have < row.target)).toBe(true);
    });

    it("offers an unsolved problem in each weak topic, never a solved or draft one", async () => {
      const found = await extras.loadRecommendExtras(userId);
      for (const candidate of found.weakTopics) {
        expect(candidate.problem.slug).not.toBe(`${tag}-asked-solved`);
        expect(candidate.problem.slug).not.toBe(`${tag}-draft-asked`);
      }
    });

    it("counts one topic per PROBLEM, not per submission", async () => {
      const base = Date.now() - 60 * 60_000;
      // Five submissions on ONE array problem is one array problem.
      for (let i = 0; i < 5; i++) await submit("arrays-a", new Date(base + i * 1_000));
      let found = await extras.loadRecommendExtras(userId);
      expect(found.recentTopics).toEqual(["ARRAYS_HASHING"]);

      // Three DIFFERENT array problems is a rut.
      await submit("arrays-b", new Date(base + 10_000));
      await submit("arrays-c", new Date(base + 20_000));
      found = await extras.loadRecommendExtras(userId);
      expect(found.recentTopics).toEqual(["ARRAYS_HASHING", "ARRAYS_HASHING", "ARRAYS_HASHING"]);

      // A different topic on top ends the rut.
      await submit("revise", new Date(base + 30_000));
      found = await extras.loadRecommendExtras(userId);
      expect(found.recentTopics[0]).toBe("TREES");
    });
  });
});
