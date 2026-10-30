import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The interview archive against the real tables (Phase 12e).
 *
 * The arithmetic is why this is a database test rather than a fake one.
 * "Asked at" frequency is a maintained count (SPEC §4(d)) that moves in
 * the same transaction as the moderator's decision, in both directions,
 * and a tag that reaches zero is deleted. None of that is provable against
 * a stub; all of it is what a student revises against.
 *
 * Opt-in: RECX_DB_TESTS=1.
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";

vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";
    process.env.IP_HASH_PEPPER ??= "interview-archive-test-pepper";
  }
});

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));

describe.skipIf(!ENABLED)("the interview archive against recx_test", () => {
  const tag = `ivw-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let db: import("@recx/db").Db;
  let archive: typeof import("@/lib/interviews/archive");
  let queries: typeof import("@/server/queries/interviews");
  let studentId = "";
  let otherId = "";
  let moderatorId = "";
  let companyId = "";
  let companySlug = "";
  let curatedCompanyId = "";
  const problems: string[] = [];

  const submission = (over: Record<string, unknown> = {}) => ({
    companyName: `Company ${tag}`,
    role: "Software Engineer",
    mode: "ON_CAMPUS",
    heldYear: 2026,
    heldMonth: 3,
    rounds: 3,
    longestRoundMinutes: 45,
    outcome: "OFFER",
    roundKinds: ["ONLINE_ASSESSMENT", "TECHNICAL"],
    topics: ["GRAPHS", "DYNAMIC_PROGRAMMING"],
    preparation: ["REC_CODE_PRACTICE"],
    problemIds: problems,
    ...over,
  });

  const tagOf = (problemId: string, company = companyId) =>
    db.problemCompanyTag.findUnique({ where: { problemId_companyId: { problemId, companyId: company } } });

  beforeAll(async () => {
    const { createPrismaClient } = await import("@recx/db");
    db = createPrismaClient({
      url: process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test",
      log: [],
    });
    archive = await import("@/lib/interviews/archive");
    queries = await import("@/server/queries/interviews");

    for (const [key, role] of [
      ["student", "STUDENT"],
      ["other", "STUDENT"],
      ["moderator", "TA_MENTOR"],
    ] as const) {
      const user = await db.user.create({
        data: {
          collegeId: `${tag}-${key}`,
          email: `${tag}-${key}@rec-code.example`,
          firstName: "A",
          lastName: key,
          handle: `${tag}-${key}`,
          role,
          batchYear: 2027,
          departmentCode: "ECE",
        },
        select: { id: true },
      });
      if (key === "student") studentId = user.id;
      else if (key === "other") otherId = user.id;
      else moderatorId = user.id;
    }

      // The slug the submission will derive from the typed company name, so
    // the "a company that already exists is linked at submission" path is
    // the one exercised rather than quietly skipped.
    companySlug = archive.slugify(`Company ${tag}`);
    companyId = (await db.company.create({ data: { slug: companySlug, name: `Company ${tag}` }, select: { id: true } })).id;
    curatedCompanyId = (
      await db.company.create({ data: { slug: `${tag}-cur`, name: `Curated ${tag}` }, select: { id: true } })
    ).id;

    for (const n of [1, 2]) {
      const problem = await db.problem.create({
        data: {
          slug: `${tag}-p${n}`,
          displayCode: `${tag}-P${n}`.toUpperCase(),
          title: `Archive problem ${n}`,
          difficulty: "EASY",
          status: "PUBLISHED",
        },
        select: { id: true },
      });
      problems.push(problem.id);
    }
    // A draft problem, which must be unnameable.
    await db.problem.create({
      data: { slug: `${tag}-draft`, displayCode: `${tag}-D`.toUpperCase(), title: "Draft", difficulty: "EASY" },
    });
    // A curated tag that predates the archive, for the label test.
    await db.problemCompanyTag.create({
      data: { problemId: problems[0]!, companyId: curatedCompanyId, frequency: 3, source: "CURATED" },
    });
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    try {
      const userIds = [studentId, otherId, moderatorId];
      await db.interviewExperienceProblem.deleteMany({ where: { problemId: { in: problems } } });
      await db.interviewExperience.deleteMany({ where: { authorId: { in: userIds } } });
      await db.problemCompanyTag.deleteMany({ where: { companyId: { in: [companyId, curatedCompanyId] } } });
      await db.problem.deleteMany({ where: { slug: { startsWith: tag } } });
      await db.company.deleteMany({ where: { id: { in: [companyId, curatedCompanyId] } } });
      await db.user.deleteMany({ where: { id: { in: userIds } } });
    } finally {
      await db.$disconnect();
    }
  }, 60_000);

  it("a submission waits, names its problems, and links a company that already exists", async () => {
    const created = await archive.submitExperienceFor(studentId, submission());
    const row = await db.interviewExperience.findUniqueOrThrow({
      where: { id: created.id },
      select: { status: true, companyId: true, authorId: true, source: true, problems: { select: { problemId: true } } },
    });
    expect(row.status).toBe("PENDING");
    expect(row.source).toBe("STUDENT");
    expect(row.authorId).toBe(studentId);
    // The slug of "Company <tag>" matches the company created above.
    expect(row.companyId).toBe(companyId);
    expect(row.problems.map((p) => p.problemId).sort()).toEqual([...problems].sort());
    // Nothing is tagged until a moderator reads it.
    expect(await tagOf(problems[0]!)).toBeNull();
  });

  it("refuses a draft problem, a future year, and a fourth waiting submission", async () => {
    const draft = await db.problem.findUniqueOrThrow({ where: { slug: `${tag}-draft` }, select: { id: true } });
    await expect(archive.submitExperienceFor(studentId, submission({ problemIds: [draft.id] }))).rejects.toThrow(
      "not there",
    );
    await expect(archive.submitExperienceFor(studentId, submission({ heldYear: 2099 }))).rejects.toThrow(
      "year that has not started",
    );

    // One is already waiting from the test above; add two more, then a fourth.
    await archive.submitExperienceFor(studentId, submission({ problemIds: [] }));
    await archive.submitExperienceFor(studentId, submission({ problemIds: [] }));
    await expect(archive.submitExperienceFor(studentId, submission({ problemIds: [] }))).rejects.toThrow(
      "waiting for a moderator",
    );
  });

  it("approving moves the company tags, in the same transaction as the decision", async () => {
    const pending = await db.interviewExperience.findFirstOrThrow({
      where: { authorId: studentId, status: "PENDING", problems: { some: {} } },
      select: { id: true },
    });
    const decision = await archive.decideExperienceAs(moderatorId, {
      experienceId: pending.id,
      approve: true,
      reason: "Specific, plausible and nothing a company could object to.",
      companyId,
    });
    expect(decision.approved).toBe(true);
    expect(decision.problemsTagged).toBe(2);

    for (const problemId of problems) {
      const tagRow = await tagOf(problemId);
      expect(tagRow).toMatchObject({ frequency: 1, source: "EXPERIENCE" });
    }
    const row = await db.interviewExperience.findUniqueOrThrow({
      where: { id: pending.id },
      select: { status: true, decidedById: true, decisionReason: true, decidedAt: true },
    });
    expect(row).toMatchObject({ status: "APPROVED", decidedById: moderatorId });
    expect(row.decisionReason).toContain("Specific");
    expect(row.decidedAt).not.toBeNull();
  });

  it("a second approved experience adds to the count rather than replacing it", async () => {
    const created = await archive.submitExperienceFor(otherId, submission());
    await archive.decideExperienceAs(moderatorId, {
      experienceId: created.id,
      approve: true,
      reason: "Second account of the same drive; consistent with the first.",
      companyId,
    });
    for (const problemId of problems) expect((await tagOf(problemId))?.frequency).toBe(2);
  });

  it("reversing an approval takes the count back, and a tag that reaches zero is removed", async () => {
    const approved = await db.interviewExperience.findMany({
      where: { status: "APPROVED", companyId, problems: { some: {} } },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
    expect(approved.length).toBe(2);

    await archive.decideExperienceAs(moderatorId, {
      experienceId: approved[0]!.id,
      approve: false,
      reason: "On a second read this is about a different company entirely.",
      companyId: null,
    });
    for (const problemId of problems) expect((await tagOf(problemId))?.frequency).toBe(1);

    await archive.decideExperienceAs(moderatorId, {
      experienceId: approved[1]!.id,
      approve: false,
      reason: "Duplicate of the first, reported twice by mistake.",
      companyId: null,
    });
    // Zero means the company no longer claims the problem at all.
    for (const problemId of problems) expect(await tagOf(problemId)).toBeNull();
  });

  it("deciding the same way twice is refused rather than counted twice", async () => {
    const decided = await db.interviewExperience.findFirstOrThrow({
      where: { status: "REJECTED" },
      select: { id: true },
    });
    await expect(
      archive.decideExperienceAs(moderatorId, {
        experienceId: decided.id,
        approve: false,
        reason: "Trying to reject the same submission a second time.",
        companyId: null,
      }),
    ).rejects.toThrow("already decided");
  });

  it("the student's view carries no name, and the moderator's does", async () => {
    const created = await archive.submitExperienceFor(studentId, submission({ problemIds: [] }));
    await archive.decideExperienceAs(moderatorId, {
      experienceId: created.id,
      approve: true,
      reason: "Clear account, nothing identifying, publish it.",
      companyId,
    });

    const page = await queries.loadArchive(otherId, null);
    const mine = page.experiences.find((entry) => entry.id === created.id);
    expect(mine).toBeDefined();
    // The author is an ECE student: the article is the one giveaway that
    // this string is built rather than stored.
    expect(mine!.by).toBe("An ECE student, batch of 2027");
    expect(JSON.stringify(page.experiences)).not.toContain(tag + "-student");

    const queue = await queries.loadPendingExperiences();
    expect(queue.pending.every((entry) => entry.author !== null || entry.by === "Collected before launch")).toBe(true);
  });

  it("only the author may withdraw, and only while nobody has read it", async () => {
    const created = await archive.submitExperienceFor(otherId, submission({ problemIds: [] }));
    await expect(archive.withdrawExperienceFor(studentId, { experienceId: created.id })).rejects.toThrow("not yours");
    await expect(archive.withdrawExperienceFor(otherId, { experienceId: created.id })).resolves.toEqual({
      id: created.id,
    });
    expect(await db.interviewExperience.findUnique({ where: { id: created.id } })).toBeNull();

    const decided = await db.interviewExperience.findFirstOrThrow({
      where: { authorId: studentId, status: { not: "PENDING" } },
      select: { id: true },
    });
    await expect(archive.withdrawExperienceFor(studentId, { experienceId: decided.id })).rejects.toThrow(
      "already decided",
    );
  });

  it("labels a curated track as curated, and an experience-backed one by its count", async () => {
    const curated = await queries.companyTagLabel(`${tag}-cur`);
    expect(curated?.source).toBe("CURATED");
    expect(curated?.notice).toContain("best guess");

    const fromExperience = await queries.companyTagLabel(companySlug);
    expect(fromExperience?.source).toBe("EXPERIENCE");
    expect(fromExperience?.notice).toMatch(/interviews? (a student|students) reported here\./);

    expect(await queries.companyTagLabel("no-such-company")).toBeNull();
  });
});
