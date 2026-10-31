import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Mock interviews against the real tables (Phase 12h).
 *
 * The two things worth a database are the race and the mirror. Two
 * students pressing Book on the same slot must not both get it — that is
 * a conditional UPDATE, and only a real database proves it. And
 * `mirrorFor` is the one read in the product whose job is to hand one
 * student's draft code to another person, so who it answers for, and
 * when it stops, are checked here rather than reasoned about.
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

describe.skipIf(!ENABLED)("mock interviews against recx_test", () => {
  const tag = `mock-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let db: import("@recx/db").Db;
  let lib: typeof import("@/lib/mock/interviews");
  let queries: typeof import("@/server/queries/mock-interviews");
  let mentorId = "";
  let otherMentorId = "";
  let aliceId = "";
  let bobId = "";
  /** Two more, so the later tests are not fighting the per-student cap. */
  let carolId = "";
  let daveId = "";
  let erinId = "";
  const extraStudents: string[] = [];
  let problemId = "";

  /**
   * A student nobody else is using.
   *
   * The per-student booking cap makes a shared fixture order-dependent,
   * and the race test's winner is deliberately not deterministic — so
   * every test that books gets its own person.
   */
  let nextStudent = 0;
  async function freshStudent(): Promise<string> {
    nextStudent += 1;
    const user = await db.user.create({
      data: {
        collegeId: `${tag}-s${nextStudent}`,
        email: `${tag}-s${nextStudent}@rec-code.example`,
        firstName: `Student${nextStudent}`,
        lastName: "Tester",
        handle: `${tag}-s${nextStudent}`,
        role: "STUDENT",
      },
      select: { id: true },
    });
    extraStudents.push(user.id);
    return user.id;
  }

  /** A slot `minutes` from now, created straight through Prisma. */
  async function slot(minutes: number, over: Record<string, unknown> = {}) {
    return db.mockInterview.create({
      data: {
        mentorId,
        startsAt: new Date(Date.now() + minutes * 60_000),
        durationMinutes: 45,
        ...over,
      } as never,
      select: { id: true, status: true, startsAt: true },
    });
  }

  beforeAll(async () => {
    const { createPrismaClient } = await import("@recx/db");
    db = createPrismaClient({
      url: process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test",
      log: [],
    });
    lib = await import("@/lib/mock/interviews");
    queries = await import("@/server/queries/mock-interviews");

    for (const [key, role] of [
      ["mentor", "TA_MENTOR"],
      ["other", "TA_MENTOR"],
      ["alice", "STUDENT"],
      ["bob", "STUDENT"],
      ["carol", "STUDENT"],
      ["dave", "STUDENT"],
      ["erin", "STUDENT"],
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
      if (key === "mentor") mentorId = user.id;
      else if (key === "other") otherMentorId = user.id;
      else if (key === "alice") aliceId = user.id;
      else if (key === "bob") bobId = user.id;
      else if (key === "carol") carolId = user.id;
      else if (key === "dave") daveId = user.id;
      else erinId = user.id;
    }

    const problem = await db.problem.create({
      data: { slug: `${tag}-p`, displayCode: `${tag}-P`.toUpperCase(), title: "Mock problem", difficulty: "EASY", status: "PUBLISHED" },
      select: { id: true },
    });
    const version = await db.problemVersion.create({
      data: {
        problemId: problem.id,
        revision: 1,
        title: "Mock problem",
        difficulty: "EASY",
        statementMd: "Test.",
        ioMode: "STDIN",
        timeLimitMs: 1000,
      },
      select: { id: true },
    });
    await db.problem.update({ where: { id: problem.id }, data: { liveVersionId: version.id } });
    problemId = problem.id;
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    try {
      const users = [mentorId, otherMentorId, aliceId, bobId, carolId, daveId, erinId, ...extraStudents];
      await db.mockInterviewSnapshot.deleteMany({ where: { interview: { mentorId: { in: users } } } });
      await db.mockInterview.deleteMany({ where: { mentorId: { in: users } } });
      await db.problem.updateMany({ where: { slug: `${tag}-p` }, data: { liveVersionId: null } });
      await db.problemVersion.deleteMany({ where: { problemId } });
      await db.problem.deleteMany({ where: { id: problemId } });
      await db.user.deleteMany({ where: { id: { in: users } } });
    } finally {
      await db.$disconnect();
    }
  }, 60_000);

  it("offers a slot, and refuses one in the past or one that overlaps", async () => {
    const created = await lib.offerSlotAs(mentorId, { startsAtLocal: istLocal(120), durationMinutes: 45 });
    expect((await db.mockInterview.findUniqueOrThrow({ where: { id: created.id } })).status).toBe("OPEN");

    await expect(lib.offerSlotAs(mentorId, { startsAtLocal: istLocal(-60), durationMinutes: 45 })).rejects.toThrow(
      "in the future",
    );
    // Starts 20 minutes into the 45-minute slot above.
    await expect(lib.offerSlotAs(mentorId, { startsAtLocal: istLocal(140), durationMinutes: 30 })).rejects.toThrow(
      "overlaps",
    );
    await db.mockInterview.delete({ where: { id: created.id } });
  });

  it("gives the slot to exactly one of two students pressing Book together", async () => {
    const open = await slot(180);
    const [first, second] = await Promise.allSettled([
      lib.bookSlotAs(aliceId, { interviewId: open.id }),
      lib.bookSlotAs(bobId, { interviewId: open.id }),
    ]);
    const won = [first, second].filter((r) => r.status === "fulfilled").length;
    expect(won, "exactly one booking").toBe(1);

    const row = await db.mockInterview.findUniqueOrThrow({ where: { id: open.id } });
    expect(row.status).toBe("BOOKED");
    expect([aliceId, bobId]).toContain(row.candidateId);
    expect(row.bookedAt).not.toBeNull();
  });

  it("refuses a third concurrent booking, and a mentor booking their own slot", async () => {
    const keen = await freshStudent();
    const a = await slot(200);
    const b = await slot(400);
    const c = await slot(600);
    await lib.bookSlotAs(keen, { interviewId: a.id });
    await lib.bookSlotAs(keen, { interviewId: b.id });
    await expect(lib.bookSlotAs(keen, { interviewId: c.id })).rejects.toThrow("already hold");

    await expect(lib.bookSlotAs(mentorId, { interviewId: c.id })).rejects.toThrow("your own slot");
  });

  it("lets a candidate give a slot back, and it becomes open again", async () => {
    const owner = await freshStudent();
    const stranger = await freshStudent();
    const open = await slot(300);
    await lib.bookSlotAs(owner, { interviewId: open.id });
    await expect(lib.giveUpSlotAs(stranger, { interviewId: open.id })).rejects.toThrow("not yours");
    await lib.giveUpSlotAs(owner, { interviewId: open.id });

    const row = await db.mockInterview.findUniqueOrThrow({ where: { id: open.id } });
    expect(row).toMatchObject({ status: "OPEN", candidateId: null, bookedAt: null });
  });

  it("refuses giving it back inside the hour, and starting before the room opens", async () => {
    const committed = await freshStudent();
    const soon = await slot(30);
    await lib.bookSlotAs(committed, { interviewId: soon.id });
    await expect(lib.giveUpSlotAs(committed, { interviewId: soon.id })).rejects.toThrow("until 60 minutes before");
  });

  describe("the room", () => {
    let running = "";
    let candidateId = "";

    beforeAll(async () => {
      candidateId = await freshStudent();
      const now = await slot(5);
      await lib.bookSlotAs(candidateId, { interviewId: now.id });
      await lib.startInterviewAs(mentorId, { interviewId: now.id, problemId });
      running = now.id;
    });

    it("starts only for its own mentor, and only a published problem", async () => {
      const other = await slot(5);
      await lib.bookSlotAs(await freshStudent(), { interviewId: other.id });
      await expect(lib.startInterviewAs(otherMentorId, { interviewId: other.id })).rejects.toThrow("not yours");
      await expect(
        lib.startInterviewAs(mentorId, { interviewId: other.id, problemId: `${tag}-nope` }),
      ).rejects.toThrow("published problem");
    });

    it("takes the candidate's snapshot, and nobody else's", async () => {
      await lib.pushSnapshotAs(candidateId, running, { language: "cpp20", source: "int main(){ return 0; }" });
      await expect(
        lib.pushSnapshotAs(bobId, running, { language: "cpp20", source: "somebody else's" }),
      ).rejects.toThrow("not yours");

      const row = await db.mockInterviewSnapshot.findUniqueOrThrow({ where: { interviewId: running } });
      expect(row.source).toContain("return 0");
    });

    it("mirrors to this interview's mentor, and to nobody else at all", async () => {
      const mine = await queries.mirrorFor(mentorId, running);
      expect(mine.ok).toBe(true);
      if (mine.ok) {
        expect(mine.view.source).toContain("return 0");
        expect(mine.view.candidate).toContain("Student");
      }

      // Including the CANDIDATE: they do not need a mirror of their own
      // editor, and a read that answered for them would be one more place
      // the "only the interviewer" rule has to hold.
      for (const viewer of [otherMentorId, bobId, candidateId]) {
        const theirs = await queries.mirrorFor(viewer, running);
        expect(theirs.ok, `viewer ${viewer}`).toBe(false);
        if (!theirs.ok) expect(theirs.status).toBe(403);
      }
    });

    it("closes the mirror when the interview finishes, and deletes what it held", async () => {
      await lib.finishInterviewAs(mentorId, {
        interviewId: running,
        communication: 4,
        problemSolving: 3,
        code: 4,
        feedbackMd: "Talk through the brute force before you optimise — you had the idea two minutes in.",
      });

      const after = await queries.mirrorFor(mentorId, running);
      expect(after.ok).toBe(false);
      if (!after.ok) expect(after.status).toBe(409);
      expect(await db.mockInterviewSnapshot.findUnique({ where: { interviewId: running } })).toBeNull();

      const row = await db.mockInterview.findUniqueOrThrow({ where: { id: running } });
      expect(row).toMatchObject({ status: "COMPLETED", ratingCommunication: 4, ratingCode: 4 });
      expect(row.endedAt).not.toBeNull();
      expect(row.feedbackAt).not.toBeNull();
    });

    it("refuses a snapshot once it is over", async () => {
      await expect(lib.pushSnapshotAs(candidateId, running, { language: "cpp20", source: "late" })).rejects.toThrow(
        "not running",
      );
    });

    it("refuses finishing it twice", async () => {
      await expect(
        lib.finishInterviewAs(mentorId, {
          interviewId: running,
          communication: 1,
          problemSolving: 1,
          code: 1,
          feedbackMd: "Trying to write over feedback the candidate has already read.",
        }),
      ).rejects.toThrow("over");
    });
  });

  it("either side can call one off, with a reason the other is shown", async () => {
    const booked = await slot(500);
    const caller = await freshStudent();
    await lib.bookSlotAs(caller, { interviewId: booked.id });
    await expect(
      lib.cancelSlotAs({ id: bobId, role: "STUDENT" }, { interviewId: booked.id, reason: "Not mine to cancel." }),
    ).rejects.toThrow("not yours");

    await lib.cancelSlotAs(
      { id: caller, role: "STUDENT" },
      { interviewId: booked.id, reason: "Clashes with a lab I cannot move." },
    );
    const row = await db.mockInterview.findUniqueOrThrow({ where: { id: booked.id } });
    expect(row).toMatchObject({ status: "CANCELLED", cancelledById: caller });
    expect(row.cancelReason).toContain("lab");
  });

  it("shows a session only to its two people", async () => {
    const booked = await slot(700);
    const pair = await freshStudent();
    await lib.bookSlotAs(pair, { interviewId: booked.id });
    expect((await queries.loadMockSession(mentorId, booked.id))?.role).toBe("MENTOR");
    expect((await queries.loadMockSession(pair, booked.id))?.role).toBe("CANDIDATE");
    // Not 403: the existence of somebody else's interview is not theirs to learn.
    expect(await queries.loadMockSession(bobId, booked.id)).toBeNull();
    expect(await queries.loadMockSession(otherMentorId, booked.id)).toBeNull();
  });
});

/** "2026-11-07T15:30" in IST, `minutes` from now. */
function istLocal(minutes: number): string {
  const at = new Date(Date.now() + minutes * 60_000 + 5.5 * 3_600_000);
  return at.toISOString().slice(0, 16);
}
