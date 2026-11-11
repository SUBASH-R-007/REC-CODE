import { beforeEach, describe, expect, it, vi } from "vitest";
import { DISCUSSION_REFUSALS, type HelpContext } from "@recx/shared";

/**
 * The discussion action bodies with a fake database (Phase 12d).
 *
 * The gate is asserted through the REAL chokepoint (lib/help/access.ts over
 * the fake rows), not a stub of it: a test that stubbed the gate would pass
 * over a build that had stopped calling it.
 *
 * The case worth the most here is the attached submission. "Share my
 * solution" takes an id from the browser, and an id that was trusted would
 * be a way to render another student's accepted code inside a post.
 */

const h = vi.hoisted(() => {
  const rows = {
    problem: null as null | { id: string; status: string; liveVersionId: string | null; editorialVisibleAt: Date | null },
    status: null as null | { status: string; attempts: number; failedAttempts: number; assisted: boolean },
    activity: null as null | { activeSeconds: number },
    submission: null as null | Record<string, unknown>,
    post: null as null | Record<string, unknown>,
    thread: null as null | Record<string, unknown>,
    reply: null as null | Record<string, unknown>,
    openReport: null as null | { id: string },
  };
  const created: Array<{ table: string; data: Record<string, unknown> }> = [];
  const make = (table: string) => async (args: { data: Record<string, unknown> }) => {
    created.push({ table, data: args.data });
    return { id: `${table}_1` };
  };
  const db = {
    problem: { findUnique: vi.fn(async () => rows.problem) },
    userProblemStatus: { findUnique: vi.fn(async () => rows.status) },
    problemActivity: { findUnique: vi.fn(async () => rows.activity) },
    submission: { findUnique: vi.fn(async () => rows.submission) },
    discussionPost: { findUnique: vi.fn(async () => rows.post), create: vi.fn(make("post")), update: vi.fn(async () => ({})) },
    doubtThread: { findUnique: vi.fn(async () => rows.thread), create: vi.fn(make("doubt")), update: vi.fn(async () => ({})) },
    doubtReply: {
      findUnique: vi.fn(async () => rows.reply),
      create: vi.fn(make("reply")),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    contentReport: { findFirst: vi.fn(async () => rows.openReport), create: vi.fn(make("report")) },
    $transaction: vi.fn(async (ops: unknown[]) => ops),
  };
  return { rows, created, db };
});

vi.mock("@/lib/db", () => ({ db: h.db }));

const posts = await import("@/lib/discussion/posts");

const PROBLEM = "prob_1";
const STUDENT = { id: "user_1", role: "STUDENT" as const };
const OTHER = { id: "user_2", role: "STUDENT" as const };
const MENTOR = { id: "user_3", role: "TA_MENTOR" as const };
const BODY = "An explanation long enough to clear the minimum the schema asks for.";

function published() {
  h.rows.problem = { id: PROBLEM, status: "PUBLISHED", liveVersionId: "ver_live", editorialVisibleAt: null };
}
function solved(assisted = false) {
  published();
  h.rows.status = { status: "SOLVED", attempts: 3, failedAttempts: 1, assisted };
  h.rows.activity = { activeSeconds: 600 };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(h.rows) as (keyof typeof h.rows)[]) h.rows[key] = null;
  h.created.length = 0;
});

describe("posting a solution", () => {
  it("is refused to somebody who has not solved it", async () => {
    published();
    await expect(
      posts.createPostFor(STUDENT, { problemId: PROBLEM, kind: "SOLUTION", bodyMd: BODY }, "PRACTICE"),
    ).rejects.toThrow(DISCUSSION_REFUSALS.unsolved);
    expect(h.created).toEqual([]);
  });

  it("is refused to somebody whose solve was assisted", async () => {
    solved(true);
    await expect(
      posts.createPostFor(STUDENT, { problemId: PROBLEM, kind: "SOLUTION", bodyMd: BODY }, "PRACTICE"),
    ).rejects.toThrow(DISCUSSION_REFUSALS.assisted);
  });

  it("is refused in a contest and an assessment, however they solved it", async () => {
    for (const context of ["CONTEST", "ASSESSMENT"] as HelpContext[]) {
      solved(false);
      await expect(
        posts.createPostFor(STUDENT, { problemId: PROBLEM, kind: "TIP", bodyMd: BODY }, context),
      ).rejects.toThrow(DISCUSSION_REFUSALS.notPractice);
    }
  });

  it("is allowed to an unassisted solver, and records what they wrote", async () => {
    solved(false);
    const post = await posts.createPostFor(STUDENT, { problemId: PROBLEM, kind: "SOLUTION", bodyMd: BODY }, "PRACTICE");
    expect(post.id).toBe("post_1");
    expect(h.created[0]!.data).toMatchObject({ problemId: PROBLEM, authorId: STUDENT.id, kind: "SOLUTION", bodyMd: BODY });
  });

  it("refuses a body too short to explain anything", async () => {
    solved(false);
    await expect(
      posts.createPostFor(STUDENT, { problemId: PROBLEM, kind: "SOLUTION", bodyMd: "did it" }, "PRACTICE"),
    ).rejects.toThrow();
  });

  it("refuses a client that tries to choose its own author or context", async () => {
    solved(false);
    await expect(
      posts.createPostFor(STUDENT, { problemId: PROBLEM, kind: "TIP", bodyMd: BODY, authorId: OTHER.id }, "PRACTICE"),
    ).rejects.toThrow();
    await expect(
      posts.createPostFor(STUDENT, { problemId: PROBLEM, kind: "TIP", bodyMd: BODY, context: "PRACTICE" }, "CONTEST"),
    ).rejects.toThrow();
  });
});

describe("the attached submission", () => {
  const attach = (over: Record<string, unknown> = {}) => {
    h.rows.submission = {
      userId: STUDENT.id,
      problemId: PROBLEM,
      verdict: "AC",
      language: "cpp20",
      origin: "PRACTICE",
      ...over,
    };
  };

  it("is attached when it is the author's own accepted practice submission", async () => {
    solved(false);
    attach();
    await posts.createPostFor(
      STUDENT,
      { problemId: PROBLEM, kind: "SOLUTION", bodyMd: BODY, submissionId: "sub_1" },
      "PRACTICE",
    );
    expect(h.created[0]!.data).toMatchObject({ submissionId: "sub_1", language: "cpp20" });
  });

  it("is refused when it belongs to somebody else", async () => {
    solved(false);
    attach({ userId: OTHER.id });
    await expect(
      posts.createPostFor(
        STUDENT,
        { problemId: PROBLEM, kind: "SOLUTION", bodyMd: BODY, submissionId: "sub_1" },
        "PRACTICE",
      ),
    ).rejects.toThrow("your own accepted submissions");
    expect(h.created).toEqual([]);
  });

  it("is refused when it is on another problem, was not accepted, or came from a sitting", async () => {
    for (const over of [{ problemId: "other" }, { verdict: "WA" }, { origin: "ASSESSMENT" }]) {
      solved(false);
      attach(over);
      await expect(
        posts.createPostFor(
          STUDENT,
          { problemId: PROBLEM, kind: "SOLUTION", bodyMd: BODY, submissionId: "sub_1" },
          "PRACTICE",
        ),
      ).rejects.toThrow("your own accepted submissions");
    }
  });

  it("is refused when it does not exist at all", async () => {
    solved(false);
    h.rows.submission = null;
    await expect(
      posts.createPostFor(
        STUDENT,
        { problemId: PROBLEM, kind: "SOLUTION", bodyMd: BODY, submissionId: "nope" },
        "PRACTICE",
      ),
    ).rejects.toThrow("your own accepted submissions");
  });
});

describe("replying to a post", () => {
  beforeEach(() => {
    h.rows.post = { id: "post_1", problemId: PROBLEM, parentId: null, status: "VISIBLE", kind: "SOLUTION" };
  });

  it("needs only a READ: an assisted solver may answer in a thread they may read", async () => {
    solved(true);
    const reply = await posts.replyToPostFor(STUDENT, { parentId: "post_1", bodyMd: "Good point." }, "PRACTICE");
    expect(reply.id).toBe("post_1");
    expect(h.created[0]!.data).toMatchObject({ parentId: "post_1", authorId: STUDENT.id });
  });

  it("is refused to somebody who has not solved it", async () => {
    published();
    await expect(
      posts.replyToPostFor(STUDENT, { parentId: "post_1", bodyMd: "Good point." }, "PRACTICE"),
    ).rejects.toThrow(DISCUSSION_REFUSALS.unsolved);
  });

  it("is refused on a hidden post, and on a reply", async () => {
    solved(false);
    h.rows.post = { id: "post_1", problemId: PROBLEM, parentId: null, status: "HIDDEN", kind: "SOLUTION" };
    await expect(posts.replyToPostFor(STUDENT, { parentId: "post_1", bodyMd: "Hi." }, "PRACTICE")).rejects.toThrow(
      DISCUSSION_REFUSALS.hidden,
    );

    h.rows.post = { id: "post_2", problemId: PROBLEM, parentId: "post_1", status: "VISIBLE", kind: "SOLUTION" };
    await expect(posts.replyToPostFor(STUDENT, { parentId: "post_2", bodyMd: "Hi." }, "PRACTICE")).rejects.toThrow(
      "not to a reply",
    );
  });
});

describe("editing", () => {
  it("is the author's own, and nobody else's — not even a moderator's", async () => {
    h.rows.post = { id: "post_1", authorId: STUDENT.id, status: "VISIBLE" };
    await expect(posts.editPostFor(STUDENT, { postId: "post_1", bodyMd: BODY })).resolves.toEqual({ id: "post_1" });
    await expect(posts.editPostFor(OTHER, { postId: "post_1", bodyMd: BODY })).rejects.toThrow("not yours");
    await expect(posts.editPostFor(MENTOR, { postId: "post_1", bodyMd: BODY })).rejects.toThrow("not yours");
  });

  it("is refused on a hidden post", async () => {
    h.rows.post = { id: "post_1", authorId: STUDENT.id, status: "HIDDEN" };
    await expect(posts.editPostFor(STUDENT, { postId: "post_1", bodyMd: BODY })).rejects.toThrow("hidden post");
  });
});

describe("doubts", () => {
  it("are asked without a solve — being stuck is the reason to ask", async () => {
    published();
    const thread = await posts.askDoubtFor(
      STUDENT,
      { problemId: PROBLEM, title: "Why does my loop stop early?", bodyMd: "I tried two pointers and it fails." },
      "PRACTICE",
    );
    expect(thread.id).toBe("doubt_1");
  });

  it("are refused during a sitting", async () => {
    published();
    await expect(
      posts.askDoubtFor(
        STUDENT,
        { problemId: PROBLEM, title: "Why does my loop stop early?", bodyMd: "I tried two pointers and it fails." },
        "ASSESSMENT",
      ),
    ).rejects.toThrow(DISCUSSION_REFUSALS.notPractice);
  });

  it("are answered by the asker and by a mentor, and by nobody else", async () => {
    h.rows.thread = { id: "d1", problemId: PROBLEM, authorId: STUDENT.id };
    await expect(posts.replyToDoubtFor(STUDENT, { threadId: "d1", bodyMd: "Figured it out." }, "PRACTICE")).resolves
      .toBeDefined();
    await expect(posts.replyToDoubtFor(MENTOR, { threadId: "d1", bodyMd: "Look at the bound." }, "PRACTICE")).resolves
      .toBeDefined();
    await expect(posts.replyToDoubtFor(OTHER, { threadId: "d1", bodyMd: "Here is the answer." }, "PRACTICE")).rejects.toThrow(
      DISCUSSION_REFUSALS.notYourDoubt,
    );
  });

  it("freeze the badge from the role at write time", async () => {
    h.rows.thread = { id: "d1", problemId: PROBLEM, authorId: STUDENT.id };
    await posts.replyToDoubtFor(MENTOR, { threadId: "d1", bodyMd: "Look at the bound." }, "PRACTICE");
    expect(h.created[0]!.data).toMatchObject({ byMentor: true });
    h.created.length = 0;
    await posts.replyToDoubtFor(STUDENT, { threadId: "d1", bodyMd: "Thanks, that was it." }, "PRACTICE");
    expect(h.created[0]!.data).toMatchObject({ byMentor: false });
  });

  it("are marked answered by the asker, and only by them", async () => {
    h.rows.reply = { id: "r1", threadId: "d1", authorId: MENTOR.id, thread: { authorId: STUDENT.id, status: "OPEN" } };
    await expect(posts.acceptAnswerFor(STUDENT, { replyId: "r1" })).resolves.toEqual({ id: "r1" });
    await expect(posts.acceptAnswerFor(OTHER, { replyId: "r1" })).rejects.toThrow("Only the student who asked");
  });

  it("cannot be answered by the asker marking their own reply", async () => {
    h.rows.reply = { id: "r1", threadId: "d1", authorId: STUDENT.id, thread: { authorId: STUDENT.id, status: "OPEN" } };
    await expect(posts.acceptAnswerFor(STUDENT, { replyId: "r1" })).rejects.toThrow("not your own");
  });
});

describe("reporting", () => {
  it("is open to anybody signed in, including somebody who cannot read the thread", async () => {
    h.rows.post = { id: "post_1" };
    // No solve at all: the gate is never consulted, because a gate on the
    // safety valve is not a safety valve.
    const report = await posts.reportContentFor(STUDENT, {
      postId: "post_1",
      doubtId: null,
      reason: "SPOILER",
      detail: "Gives the whole answer away in the first line.",
    });
    expect(report.id).toBe("report_1");
  });

  it("refuses a second open report of the same thing from the same person", async () => {
    h.rows.post = { id: "post_1" };
    h.rows.openReport = { id: "existing" };
    await expect(
      posts.reportContentFor(STUDENT, {
        postId: "post_1",
        doubtId: null,
        reason: "SPAM",
        detail: "Still an advertisement.",
      }),
    ).rejects.toThrow("already reported");
  });

  it("refuses a report that names both targets, or neither", async () => {
    for (const target of [{ postId: "post_1", doubtId: "d1" }, { postId: null, doubtId: null }]) {
      await expect(
        posts.reportContentFor(STUDENT, { ...target, reason: "OTHER", detail: "Something is wrong here." }),
      ).rejects.toThrow();
    }
  });
});

describe("who counts as a moderator", () => {
  it("is the three roles the spec names, and no student", () => {
    expect(posts.isModerator("TA_MENTOR")).toBe(true);
    expect(posts.isModerator("ADMIN")).toBe(true);
    expect(posts.isModerator("SUPER_ADMIN")).toBe(true);
    expect(posts.isModerator("STUDENT")).toBe(false);
    // SPEC §9: a placement officer is analytics only — no moderation.
    expect(posts.isModerator("PLACEMENT_OFFICER")).toBe(false);
  });
});
