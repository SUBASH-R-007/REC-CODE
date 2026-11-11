import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * toggleBookmark: the session decides whose bookmark it is, input is
 * validated before the database is touched, only published problems can be
 * bookmarked, and both directions are idempotent writes.
 */

const state = vi.hoisted(() => ({
  user: null as { id: string } | null,
  problem: null as { id: string } | null,
  calls: [] as { op: string; args: unknown }[],
}));

vi.mock("@/lib/auth/guards", async () => {
  const { UnauthorizedError } = await import("@/lib/errors");
  return {
    requireActionUser: async () => {
      if (!state.user) throw new UnauthorizedError();
      return state.user;
    },
  };
});

vi.mock("@/lib/db", () => ({
  db: {
    problem: {
      findFirst: async (args: unknown) => {
        state.calls.push({ op: "problem.findFirst", args });
        return state.problem;
      },
    },
    bookmark: {
      createMany: async (args: unknown) => {
        state.calls.push({ op: "bookmark.createMany", args });
        return { count: 1 };
      },
      deleteMany: async (args: unknown) => {
        state.calls.push({ op: "bookmark.deleteMany", args });
        return { count: 1 };
      },
    },
  },
}));

const { toggleBookmark } = await import("@/server/actions/bookmarks");

beforeEach(() => {
  state.user = { id: "user-1" };
  state.problem = { id: "prob-1" };
  state.calls = [];
});

describe("toggleBookmark", () => {
  it("refuses anonymous callers before touching the database", async () => {
    state.user = null;
    const result = await toggleBookmark({ problemId: "prob-1", bookmarked: true });
    expect(result).toEqual({ ok: false, error: "You need to sign in to do that." });
    expect(state.calls).toEqual([]);
  });

  it.each([
    ["a missing problem id", { bookmarked: true }],
    ["an empty problem id", { problemId: "   ", bookmarked: true }],
    ["an over-long problem id", { problemId: "x".repeat(65), bookmarked: true }],
    ["a non-string problem id", { problemId: 42, bookmarked: true }],
    ["a missing desired state", { problemId: "prob-1" }],
    ["a string desired state", { problemId: "prob-1", bookmarked: "true" }],
    ["null input", null],
  ])("rejects %s without touching the database", async (_label, input) => {
    const result = await toggleBookmark(input as never);
    expect(result.ok).toBe(false);
    expect(state.calls).toEqual([]);
  });

  it("adds a bookmark for the session user only, idempotently", async () => {
    const result = await toggleBookmark({ problemId: " prob-1 ", bookmarked: true, userId: "someone-else" } as never);
    expect(result).toEqual({ ok: true, data: { bookmarked: true } });
    expect(state.calls).toEqual([
      { op: "problem.findFirst", args: { where: { id: "prob-1", status: "PUBLISHED" }, select: { id: true } } },
      {
        op: "bookmark.createMany",
        args: { data: [{ userId: "user-1", problemId: "prob-1" }], skipDuplicates: true },
      },
    ]);
  });

  it("refuses to bookmark a problem that is not published", async () => {
    state.problem = null;
    const result = await toggleBookmark({ problemId: "draft-1", bookmarked: true });
    expect(result).toEqual({ ok: false, error: "That problem is not available." });
    expect(state.calls.map((c) => c.op)).toEqual(["problem.findFirst"]);
  });

  it("removes only the session user's bookmark", async () => {
    const result = await toggleBookmark({ problemId: "prob-1", bookmarked: false });
    expect(result).toEqual({ ok: true, data: { bookmarked: false } });
    expect(state.calls).toEqual([
      { op: "bookmark.deleteMany", args: { where: { userId: "user-1", problemId: "prob-1" } } },
    ]);
  });
});
