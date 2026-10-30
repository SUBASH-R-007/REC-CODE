import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Written answers against the real tables (Phase 12i).
 *
 * What needs a database here is the marking: the grade is one
 * transaction over three tables, and the CHECKs refuse a half-written
 * one. Everything a unit test cannot reach is here — the (prompt,
 * author) key that makes one answer per student, the rubric that must be
 * complete and must belong to THIS question, the hand-back that puts the
 * answer back in the student's drafts, and the reads that must refuse a
 * question nobody published.
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

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));

const LONG_ANSWER =
  "I would start with a single writer and a read replica, because the read load is a hundred times the write load and the cheapest correct thing is to separate them. The failure I am most worried about is replication lag on the profile page.";

describe.skipIf(!ENABLED)("written answers against recx_test", () => {
  const tag = `wr-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let db: import("@recx/db").Db;
  let lib: typeof import("@/lib/written/answers");
  let queries: typeof import("@/server/queries/written");
  let taId = "";
  let otherTaId = "";
  let studentId = "";
  let otherStudentId = "";
  const createdPrompts: string[] = [];

  const ta = () => ({ id: taId, role: "TA_MENTOR" as const });

  /** A published question with a two-line rubric. */
  async function publishedPrompt(title: string, weights: number[] = [5, 1]) {
    const prompt = await lib.createPromptAs(taId, {
      kind: "SYSTEM_DESIGN",
      title,
      promptMd: "Design something that holds up when twice as many people use it as you planned for.",
      timeBoxMinutes: 45,
      criteria: weights.map((weight, i) => ({ label: `Criterion ${i + 1} for ${title}`, weight })),
    });
    createdPrompts.push(prompt.id);
    await lib.publishPromptAs(ta(), { promptId: prompt.id });
    return prompt.id;
  }

  async function criteriaOf(promptId: string) {
    return db.writtenCriterion.findMany({
      where: { promptId },
      orderBy: { order: "asc" },
      select: { id: true, weight: true },
    });
  }

  beforeAll(async () => {
    const { createPrismaClient } = await import("@recx/db");
    db = createPrismaClient({
      url: process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test",
      log: [],
    });
    lib = await import("@/lib/written/answers");
    queries = await import("@/server/queries/written");

    for (const [key, role] of [
      ["ta", "TA_MENTOR"],
      ["other-ta", "TA_MENTOR"],
      ["student", "STUDENT"],
      ["other-student", "STUDENT"],
    ] as const) {
      const user = await db.user.create({
        data: {
          collegeId: `${tag}-${key}`,
          email: `${tag}-${key}@rec-code.example`,
          firstName: key,
          lastName: "Tester",
          handle: `${tag}-${key}`,
          role,
        },
        select: { id: true },
      });
      if (key === "ta") taId = user.id;
      else if (key === "other-ta") otherTaId = user.id;
      else if (key === "student") studentId = user.id;
      else otherStudentId = user.id;
    }
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    try {
      const users = [taId, otherTaId, studentId, otherStudentId];
      await db.writtenMark.deleteMany({ where: { answer: { authorId: { in: users } } } });
      await db.writtenAnswer.deleteMany({ where: { authorId: { in: users } } });
      await db.writtenCriterion.deleteMany({ where: { promptId: { in: createdPrompts } } });
      await db.writtenPrompt.deleteMany({ where: { authorId: { in: users } } });
      await db.user.deleteMany({ where: { id: { in: users } } });
    } finally {
      await db.$disconnect();
    }
  }, 60_000);

  it("writes a question as a draft, and nobody can answer it until it is open", async () => {
    const prompt = await lib.createPromptAs(taId, {
      kind: "WRITTEN",
      title: `${tag} a draft question`,
      promptMd: "Explain why a database index makes reads faster and writes slower, in your own words.",
      timeBoxMinutes: 20,
      criteria: [
        { label: "Says what an index is", weight: 2 },
        { label: "Says what it costs", weight: 4 },
      ],
    });
    createdPrompts.push(prompt.id);

    const row = await db.writtenPrompt.findUnique({
      where: { id: prompt.id },
      select: { status: true, publishedAt: true, slug: true, _count: { select: { criteria: true } } },
    });
    expect(row).toMatchObject({ status: "DRAFT", publishedAt: null });
    expect(row?._count.criteria).toBe(2);
    expect(row?.slug).toContain("a-draft-question");

    await expect(lib.saveDraftAs(studentId, { promptId: prompt.id, bodyMd: "x" })).rejects.toThrow("not open");
    // And it is not readable: an unpublished question is not a student's.
    expect(await queries.loadPromptForStudent(studentId, row!.slug)).toBeNull();
  });

  it("refuses two criteria with the same name, and a rubric of one", async () => {
    await expect(
      lib.createPromptAs(taId, {
        kind: "WRITTEN",
        title: `${tag} the same twice`,
        promptMd: "Explain why a database index makes reads faster and writes slower, in your own words.",
        timeBoxMinutes: 20,
        criteria: [
          { label: "Clarity", weight: 2 },
          { label: "clarity", weight: 2 },
        ],
      }),
    ).rejects.toThrow("marked apart");

    await expect(
      lib.createPromptAs(taId, {
        kind: "WRITTEN",
        title: `${tag} one line only`,
        promptMd: "Explain why a database index makes reads faster and writes slower, in your own words.",
        timeBoxMinutes: 20,
        criteria: [{ label: "Clarity", weight: 2 }],
      }),
    ).rejects.toThrow("at least two");
  });

  it("publishes, and refuses to reopen what has been retired", async () => {
    const promptId = await publishedPrompt(`${tag} published and retired`);
    await lib.retirePromptAs(ta(), { promptId });
    const row = await db.writtenPrompt.findUnique({
      where: { id: promptId },
      select: { status: true, retiredAt: true, publishedAt: true },
    });
    expect(row?.status).toBe("RETIRED");
    expect(row?.retiredAt).not.toBeNull();
    // Retiring is not deleting: it was open, and the row still says when.
    expect(row?.publishedAt).not.toBeNull();
    await expect(lib.publishPromptAs(ta(), { promptId })).rejects.toThrow("cannot reopen");
  });

  it("is one answer per student per question, and a draft saves over itself", async () => {
    const promptId = await publishedPrompt(`${tag} one answer each`);
    await lib.saveDraftAs(studentId, { promptId, bodyMd: "First thoughts." });
    await lib.saveDraftAs(studentId, { promptId, bodyMd: "Second thoughts." });
    const rows = await db.writtenAnswer.findMany({ where: { promptId }, select: { bodyMd: true, status: true } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ bodyMd: "Second thoughts.", status: "DRAFT" });
  });

  it("refuses a short answer at the door, and keeps the draft editable until it is handed in", async () => {
    const promptId = await publishedPrompt(`${tag} long enough`);
    await expect(lib.submitAnswerAs(studentId, { promptId, bodyMd: "Too short." })).rejects.toThrow("not enough here");

    await lib.submitAnswerAs(studentId, { promptId, bodyMd: LONG_ANSWER });
    const row = await db.writtenAnswer.findFirst({
      where: { promptId, authorId: studentId },
      select: { status: true, submittedAt: true },
    });
    expect(row?.status).toBe("SUBMITTED");
    expect(row?.submittedAt).not.toBeNull();

    await expect(lib.saveDraftAs(studentId, { promptId, bodyMd: "Changed my mind." })).rejects.toThrow(
      "already handed that in",
    );
  });

  it("marks an answer in one write: the marks, the note and the total that was true at the time", async () => {
    const promptId = await publishedPrompt(`${tag} marked properly`, [5, 3]);
    const criteria = await criteriaOf(promptId);
    await lib.submitAnswerAs(studentId, { promptId, bodyMd: LONG_ANSWER });
    const answer = await db.writtenAnswer.findFirstOrThrow({
      where: { promptId, authorId: studentId },
      select: { id: true },
    });

    await lib.gradeAnswerAs(otherTaId, {
      answerId: answer.id,
      marks: [
        { criterionId: criteria[0]!.id, points: 4, note: "The read path is right." },
        { criterionId: criteria[1]!.id, points: 2 },
      ],
      overallMd: "Say what happens when the replica falls behind, and you have the whole answer.",
    });

    const graded = await db.writtenAnswer.findUniqueOrThrow({
      where: { id: answer.id },
      select: {
        status: true,
        graderId: true,
        gradedAt: true,
        points: true,
        outOf: true,
        overallMd: true,
        marks: { select: { criterionId: true, points: true, note: true } },
      },
    });
    expect(graded.status).toBe("GRADED");
    expect(graded.graderId).toBe(otherTaId);
    expect(graded.gradedAt).not.toBeNull();
    // 5×4 + 3×2 out of (5+3)×4.
    expect(graded.points).toBe(26);
    expect(graded.outOf).toBe(32);
    expect(graded.marks).toHaveLength(2);
    expect(graded.marks.find((m) => m.criterionId === criteria[0]!.id)?.note).toContain("read path");

    // And it is final.
    await expect(
      lib.gradeAnswerAs(otherTaId, {
        answerId: answer.id,
        marks: criteria.map((c) => ({ criterionId: c.id, points: 4 })),
        overallMd: "Changing my mind about this one, which should not be possible.",
      }),
    ).rejects.toThrow("already been marked");
  });

  it("refuses a rubric with a gap, a criterion marked twice, and one from another question", async () => {
    const promptId = await publishedPrompt(`${tag} rubric must be whole`, [2, 2]);
    const elsewhere = await publishedPrompt(`${tag} another question entirely`, [1, 1]);
    const criteria = await criteriaOf(promptId);
    const foreign = await criteriaOf(elsewhere);
    await lib.submitAnswerAs(studentId, { promptId, bodyMd: LONG_ANSWER });
    const answer = await db.writtenAnswer.findFirstOrThrow({
      where: { promptId, authorId: studentId },
      select: { id: true },
    });
    const overallMd = "There is enough here to say something useful about the storage layer.";

    await expect(
      lib.gradeAnswerAs(otherTaId, {
        answerId: answer.id,
        marks: [
          { criterionId: criteria[0]!.id, points: 3 },
          { criterionId: foreign[0]!.id, points: 3 },
        ],
        overallMd,
      }),
    ).rejects.toThrow("rubric with a gap");

    await expect(
      lib.gradeAnswerAs(otherTaId, {
        answerId: answer.id,
        marks: [
          { criterionId: criteria[0]!.id, points: 3 },
          { criterionId: criteria[0]!.id, points: 1 },
        ],
        overallMd,
      }),
    ).rejects.toThrow("marked twice");

    // Nothing was written by either refusal.
    expect(await db.writtenMark.count({ where: { answerId: answer.id } })).toBe(0);
    expect((await db.writtenAnswer.findUniqueOrThrow({ where: { id: answer.id } })).status).toBe("SUBMITTED");
  });

  it("refuses a grader marking their own answer, even a TA's", async () => {
    const promptId = await publishedPrompt(`${tag} not your own`);
    const criteria = await criteriaOf(promptId);
    // A TA answering somebody else's question is a student here.
    await lib.submitAnswerAs(otherTaId, { promptId, bodyMd: LONG_ANSWER });
    const answer = await db.writtenAnswer.findFirstOrThrow({
      where: { promptId, authorId: otherTaId },
      select: { id: true },
    });

    await expect(
      lib.gradeAnswerAs(otherTaId, {
        answerId: answer.id,
        marks: criteria.map((c) => ({ criterionId: c.id, points: 4 })),
        overallMd: "Marking my own work, which the product does not allow at any level.",
      }),
    ).rejects.toThrow("your own answer");
    const refused = await queries.loadForGrading(otherTaId, answer.id);
    expect(refused.ok).toBe(false);
  });

  it("hands an answer back into the student's drafts, with the note they are shown", async () => {
    const promptId = await publishedPrompt(`${tag} handed back`);
    await lib.submitAnswerAs(studentId, { promptId, bodyMd: LONG_ANSWER });
    const answer = await db.writtenAnswer.findFirstOrThrow({
      where: { promptId, authorId: studentId },
      select: { id: true },
    });

    await lib.handBackAs(otherTaId, {
      answerId: answer.id,
      note: "You have described the API and not the storage. Add the second half.",
    });
    const back = await db.writtenAnswer.findUniqueOrThrow({
      where: { id: answer.id },
      select: { status: true, submittedAt: true, handBackNote: true, handedBackAt: true, bodyMd: true },
    });
    expect(back.status).toBe("DRAFT");
    expect(back.submittedAt).toBeNull();
    expect(back.handedBackAt).not.toBeNull();
    expect(back.handBackNote).toContain("not the storage");
    // Their words are untouched: it is their draft again, not a blank one.
    expect(back.bodyMd).toBe(LONG_ANSWER);

    // And they can edit and hand it in again.
    await lib.saveDraftAs(studentId, { promptId, bodyMd: `${LONG_ANSWER} The storage is a single table.` });
    await lib.submitAnswerAs(studentId, { promptId, bodyMd: `${LONG_ANSWER} The storage is a single table.` });
    expect((await db.writtenAnswer.findUniqueOrThrow({ where: { id: answer.id } })).status).toBe("SUBMITTED");
  });

  it("shows a student their own answer and nobody else's", async () => {
    const promptId = await publishedPrompt(`${tag} mine only`);
    const slug = (await db.writtenPrompt.findUniqueOrThrow({ where: { id: promptId }, select: { slug: true } })).slug;
    await lib.submitAnswerAs(studentId, { promptId, bodyMd: LONG_ANSWER });

    const mine = await queries.loadPromptForStudent(studentId, slug);
    expect(mine?.answer?.bodyMd).toBe(LONG_ANSWER);
    const theirs = await queries.loadPromptForStudent(otherStudentId, slug);
    expect(theirs?.prompt.title).toContain("mine only");
    // The question, yes. Somebody else's answer, no.
    expect(theirs?.answer).toBeNull();
  });

  it("keeps a retired question readable by whoever answered it, and by nobody else", async () => {
    const promptId = await publishedPrompt(`${tag} retired but answered`);
    const slug = (await db.writtenPrompt.findUniqueOrThrow({ where: { id: promptId }, select: { slug: true } })).slug;
    await lib.submitAnswerAs(studentId, { promptId, bodyMd: LONG_ANSWER });
    await lib.retirePromptAs(ta(), { promptId });

    expect((await queries.loadPromptForStudent(studentId, slug))?.answer?.bodyMd).toBe(LONG_ANSWER);
    expect(await queries.loadPromptForStudent(otherStudentId, slug)).toBeNull();
    const listed = await queries.loadOpenPrompts(studentId);
    expect(listed.some((p) => p.slug === slug && p.status === "RETIRED")).toBe(true);
    expect((await queries.loadOpenPrompts(otherStudentId)).some((p) => p.slug === slug)).toBe(false);
  });

  it("puts a submitted answer in the shared queue, oldest first, minus the grader's own", async () => {
    const promptId = await publishedPrompt(`${tag} in the queue`);
    await lib.submitAnswerAs(studentId, { promptId, bodyMd: LONG_ANSWER });
    const queue = await queries.loadGradingQueue(otherTaId);
    const row = queue.find((r) => r.promptTitle.includes("in the queue"));
    expect(row).toBeDefined();
    expect(row?.words).toBeGreaterThan(20);

    const ownPrompt = await publishedPrompt(`${tag} the grader's own answer`);
    await lib.submitAnswerAs(otherTaId, { promptId: ownPrompt, bodyMd: LONG_ANSWER });
    const theirQueue = await queries.loadGradingQueue(otherTaId);
    expect(theirQueue.some((r) => r.promptTitle.includes("the grader's own answer"))).toBe(false);
  });

  it("refuses to grade what has not been handed in", async () => {
    const promptId = await publishedPrompt(`${tag} still a draft`);
    const criteria = await criteriaOf(promptId);
    await lib.saveDraftAs(studentId, { promptId, bodyMd: "Half an answer." });
    const answer = await db.writtenAnswer.findFirstOrThrow({
      where: { promptId, authorId: studentId },
      select: { id: true },
    });
    await expect(
      lib.gradeAnswerAs(otherTaId, {
        answerId: answer.id,
        marks: criteria.map((c) => ({ criterionId: c.id, points: 2 })),
        overallMd: "Marking a draft nobody handed in, which must not be possible.",
      }),
    ).rejects.toThrow("not been handed in");
  });

  it("refuses a question that is not somebody's to publish or retire", async () => {
    const prompt = await lib.createPromptAs(taId, {
      kind: "WRITTEN",
      title: `${tag} whose question is it`,
      promptMd: "Explain why a database index makes reads faster and writes slower, in your own words.",
      timeBoxMinutes: 20,
      criteria: [
        { label: "Says what an index is", weight: 2 },
        { label: "Says what it costs", weight: 4 },
      ],
    });
    createdPrompts.push(prompt.id);
    const stranger = { id: otherTaId, role: "TA_MENTOR" as const };
    await expect(lib.publishPromptAs(stranger, { promptId: prompt.id })).rejects.toThrow("not yours");
    await expect(lib.retirePromptAs(stranger, { promptId: prompt.id })).rejects.toThrow("not yours");
    // Staff may, because a TA who leaves must not take a question with them.
    await lib.publishPromptAs({ id: otherTaId, role: "ADMIN" }, { promptId: prompt.id });
    expect((await db.writtenPrompt.findUniqueOrThrow({ where: { id: prompt.id } })).status).toBe("PUBLISHED");
  });

  it("refuses a half-written mark at the database, whatever the application does", async () => {
    const promptId = await publishedPrompt(`${tag} the database says no`);
    await lib.submitAnswerAs(studentId, { promptId, bodyMd: LONG_ANSWER });
    const answer = await db.writtenAnswer.findFirstOrThrow({
      where: { promptId, authorId: studentId },
      select: { id: true },
    });

    // GRADED without a grader, a note or a total.
    await expect(
      db.writtenAnswer.update({ where: { id: answer.id }, data: { status: "GRADED" } }),
    ).rejects.toThrow();
    // A total that is more than the rubric offers.
    await expect(
      db.writtenAnswer.update({
        where: { id: answer.id },
        data: { status: "GRADED", graderId: otherTaId, gradedAt: new Date(), overallMd: "A note that is long enough to pass the floor.", points: 99, outOf: 8 },
      }),
    ).rejects.toThrow();
    // A grader who is the author.
    await expect(
      db.writtenAnswer.update({
        where: { id: answer.id },
        data: { status: "GRADED", graderId: studentId, gradedAt: new Date(), overallMd: "A note that is long enough to pass the floor.", points: 4, outOf: 8 },
      }),
    ).rejects.toThrow();
    expect((await db.writtenAnswer.findUniqueOrThrow({ where: { id: answer.id } })).status).toBe("SUBMITTED");
  });
});
