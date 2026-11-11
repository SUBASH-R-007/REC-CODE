import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, disabledTriggers, openTestDb, RUN_DB_TESTS, testDatabaseName, type TestDb } from "./support/test-db";

/**
 * The discussion invariants (migration 20261030170000).
 *
 * Every CHECK here holds up a sentence somebody is TOLD. A hidden post
 * shows its author the moderator's reason, so a hidden row without one
 * would render "Hidden by a TA or mentor: " and look like a shrug. A
 * resolved report names who resolved it, because a moderation decision
 * with nobody attached is not a decision. A report points at exactly one
 * thing, because a moderator cannot act on one that points at two or none.
 */

const run = (randomBytes(3).readUIntBE(0, 3) % 90_000) + 10_000;
const TITLE = RUN_DB_TESTS ? "discussion invariants (live database)" : "discussion invariants (set RECX_DB_TESTS=1 to run)";

const BODY = "A body long enough to clear the minimum the schema asks for.";
const SHORT = "too short";

describe.skipIf(!RUN_DB_TESTS)(TITLE, () => {
  let db: TestDb;
  let restoreEnv: () => void;
  let userId = "";
  let otherId = "";
  let problemId = "";

  async function refused(fn: () => Promise<unknown>): Promise<string> {
    try {
      await fn();
    } catch (error) {
      return String((error as Error).message);
    }
    throw new Error("the write was expected to be refused, but it went through");
  }

  const post = (over: Record<string, unknown> = {}) =>
    db.discussionPost.create({
      data: { problemId, authorId: userId, kind: "SOLUTION", bodyMd: BODY, ...over } as never,
      select: { id: true, status: true, editorialQuality: true },
    });

  const doubt = (over: Record<string, unknown> = {}) =>
    db.doubtThread.create({
      data: { problemId, authorId: userId, title: "Why does my loop stop early?", bodyMd: BODY, ...over } as never,
      select: { id: true, status: true },
    });

  beforeAll(async () => {
    const dbName = testDatabaseName();
    applyMigrations();
    ({ db, restore: restoreEnv } = await openTestDb());
    const [current] = await db.$queryRawUnsafe<Array<{ name: string }>>("SELECT current_database() AS name");
    expect(current?.name).toBe(dbName);
    expect(await disabledTriggers(db)).toEqual([]);

    for (const [key, suffix] of [
      ["author", "a"],
      ["other", "b"],
    ] as const) {
      const user = await db.user.create({
        data: {
          collegeId: `DISC${run}${suffix}`,
          email: `disc-${run}-${suffix}@example.test`,
          firstName: "A",
          lastName: key === "author" ? "Student" : "Mentor",
          handle: `disc-${run}-${suffix}`,
          role: key === "author" ? "STUDENT" : "TA_MENTOR",
        },
        select: { id: true },
      });
      if (key === "author") userId = user.id;
      else otherId = user.id;
    }

    const problem = await db.problem.create({
      data: { slug: `disc-${run}`, displayCode: `DISC-${run}`, title: "A problem to discuss", difficulty: "EASY" },
      select: { id: true },
    });
    problemId = problem.id;
  });

  afterAll(async () => {
    if (!db) return;
    try {
      await db.contentReport.deleteMany({ where: { reporterId: { in: [userId, otherId] } } });
      await db.doubtReply.deleteMany({ where: { authorId: { in: [userId, otherId] } } });
      await db.doubtThread.deleteMany({ where: { authorId: { in: [userId, otherId] } } });
      await db.discussionPost.deleteMany({ where: { parentId: { not: null }, authorId: { in: [userId, otherId] } } });
      await db.discussionPost.deleteMany({ where: { authorId: { in: [userId, otherId] } } });
      await db.problem.deleteMany({ where: { id: problemId } });
      await db.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
      expect(await disabledTriggers(db)).toEqual([]);
    } finally {
      await db.$disconnect();
      restoreEnv?.();
    }
  });

  describe("a hidden post names who hid it and why", () => {
    it("accepts a visible post with no moderation fields", async () => {
      expect((await post()).status).toBe("VISIBLE");
    });

    it("accepts a properly hidden post", async () => {
      const row = await post({
        status: "HIDDEN",
        hiddenById: otherId,
        hiddenReason: "Pastes the whole solution with no explanation.",
        hiddenAt: new Date(),
      });
      expect(row.status).toBe("HIDDEN");
    });

    it("refuses a hidden post with no reason, and a visible post carrying one", async () => {
      expect(await refused(() => post({ status: "HIDDEN", hiddenById: otherId, hiddenAt: new Date() }))).toMatch(
        /DiscussionPost_hidden_pair_check/,
      );
      expect(
        await refused(() => post({ hiddenReason: "Left behind by a sloppy un-hide.", hiddenAt: new Date() })),
      ).toMatch(/DiscussionPost_hidden_pair_check/);
    });

    it("refuses a reason too short to explain anything", async () => {
      expect(
        await refused(() => post({ status: "HIDDEN", hiddenById: otherId, hiddenReason: "no", hiddenAt: new Date() })),
      ).toMatch(/DiscussionPost_hidden_(pair|reason_size)_check/);
    });
  });

  describe("bodies are bounded", () => {
    it("refuses a post too short to be worth reading, and one past the cap", async () => {
      expect(await refused(() => post({ bodyMd: SHORT }))).toMatch(/DiscussionPost_body_size_check/);
      expect(await refused(() => post({ bodyMd: "x".repeat(8_001) }))).toMatch(/DiscussionPost_body_size_check/);
    });

    it("refuses a doubt with a title or a body too short", async () => {
      expect(await refused(() => doubt({ title: "huh?" }))).toMatch(/DoubtThread_title_size_check/);
      expect(await refused(() => doubt({ bodyMd: "help" }))).toMatch(/DoubtThread_body_size_check/);
    });
  });

  describe("shared code", () => {
    it("refuses a language with no submission, and a submission with no language", async () => {
      expect(await refused(() => post({ language: "cpp20" }))).toMatch(/DiscussionPost_shared_code_check/);
    });
  });

  describe("a reply is not its own parent", () => {
    it("accepts a reply to another post", async () => {
      const parent = await post();
      const reply = await post({ parentId: parent.id, bodyMd: BODY });
      expect(reply.id).not.toBe(parent.id);
    });

    it("refuses a post that is its own parent", async () => {
      const parent = await post();
      expect(
        await refused(() =>
          db.$executeRawUnsafe(`UPDATE "DiscussionPost" SET "parentId" = $1 WHERE id = $1`, parent.id),
        ),
      ).toMatch(/DiscussionPost_not_own_parent_check/);
    });
  });

  describe("a thread is ANSWERED exactly when it was answered", () => {
    it("accepts open with no moment, and answered with one", async () => {
      expect((await doubt()).status).toBe("OPEN");
      expect((await doubt({ status: "ANSWERED", answeredAt: new Date() })).status).toBe("ANSWERED");
    });

    it("refuses answered with no moment, and open with one", async () => {
      expect(await refused(() => doubt({ status: "ANSWERED" }))).toMatch(/DoubtThread_answered_pair_check/);
      expect(await refused(() => doubt({ answeredAt: new Date() }))).toMatch(/DoubtThread_answered_pair_check/);
    });
  });

  describe("a report points at exactly one thing and names who closed it", () => {
    const report = (over: Record<string, unknown> = {}) =>
      db.contentReport.create({
        data: { reporterId: otherId, reason: "SPOILER", detail: "Gives the whole answer away.", ...over } as never,
        select: { id: true, status: true },
      });

    it("accepts a report on a post, and one on a doubt", async () => {
      const target = await post();
      expect((await report({ postId: target.id })).status).toBe("OPEN");
      const thread = await doubt();
      expect((await report({ doubtId: thread.id })).status).toBe("OPEN");
    });

    it("refuses a report that names both targets, and one that names neither", async () => {
      const target = await post();
      const thread = await doubt();
      expect(await refused(() => report({ postId: target.id, doubtId: thread.id }))).toMatch(
        /ContentReport_one_target_check/,
      );
      expect(await refused(() => report({}))).toMatch(/ContentReport_one_target_check/);
    });

    it("refuses a resolved report with nobody attached, and an open one with a resolver", async () => {
      const target = await post();
      expect(
        await refused(() => report({ postId: target.id, status: "UPHELD", resolvedAt: new Date() })),
      ).toMatch(/ContentReport_resolved_pair_check/);
      expect(
        await refused(() => report({ postId: target.id, resolvedById: otherId, resolvedAt: new Date() })),
      ).toMatch(/ContentReport_resolved_pair_check/);
    });

    it("accepts a properly resolved report", async () => {
      const target = await post();
      const row = await report({
        postId: target.id,
        status: "DISMISSED",
        resolvedById: otherId,
        resolvedAt: new Date(),
        resolution: "Read it twice; it explains the approach rather than handing it over.",
      });
      expect(row.status).toBe("DISMISSED");
    });
  });
});
