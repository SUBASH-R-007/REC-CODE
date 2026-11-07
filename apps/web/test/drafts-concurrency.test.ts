import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Two saves of the same draft racing on its FIRST write (Phase 15k).
 *
 * `drafts-server.db.test.ts` asserts that concurrent first saves settle on
 * the newest, and on 2026-11-07 the Linux gate caught it settling on the
 * older one — under the load of the whole suite, and never on its own. It
 * was not the test: the window is real and small, so only a loaded machine
 * finds it.
 *
 * `saveServerDraft` tries a conditional `UPDATE … WHERE clientUpdatedAt <=
 * mine` first, and reads "nothing updated" as "either the stored draft is
 * newer, or there is none yet". There is a third case. The row can appear
 * BETWEEN that update and the `findUnique` that follows it — put there by a
 * concurrent first save — and be OLDER than this one. The code then found a
 * row, concluded the stored draft must be newer, and returned
 * `{saved:false}` without writing anything: the student's latest keystrokes
 * dropped on the floor, silently, with the save reported as a no-op.
 *
 * The fix is the retry the unique-violation path already does. The test
 * below forces the interleaving rather than hoping for it, which is the
 * only way a window this narrow stays closed.
 */

const h = vi.hoisted(() => {
  interface Row {
    userId: string;
    problemId: string;
    language: string;
    source: string;
    clientUpdatedAt: Date;
  }
  const rows = new Map<string, Row>();
  const key = (where: { userId?: string; problemId?: string; language?: string }) =>
    `${where.userId}/${where.problemId}/${where.language}`;
  const state = {
    rows,
    updateCalls: 0,
    /**
     * The race, made to happen: the first conditional update behaves as if
     * the row were not there yet (it was not, when the statement began),
     * and the competing save's row lands immediately afterwards.
     */
    raceRow: null as Row | null,
  };

  const db = {
    problem: {
      findFirst: vi.fn(async () => ({ id: "prob_1" })),
    },
    codeDraft: {
      updateMany: vi.fn(
        async (args: {
          where: { userId: string; problemId: string; language: string; clientUpdatedAt: { lte: Date } };
          data: { source: string; clientUpdatedAt: Date };
        }) => {
          state.updateCalls += 1;
          if (state.updateCalls === 1 && state.raceRow) {
            // Nothing to update yet — and now the other save commits.
            rows.set(key(state.raceRow), { ...state.raceRow });
            return { count: 0 };
          }
          const row = rows.get(key(args.where));
          if (!row) return { count: 0 };
          if (row.clientUpdatedAt.getTime() > args.where.clientUpdatedAt.lte.getTime()) return { count: 0 };
          row.source = args.data.source;
          row.clientUpdatedAt = args.data.clientUpdatedAt;
          return { count: 1 };
        },
      ),
      findUnique: vi.fn(async (args: { where: { userId_problemId_language: { userId: string; problemId: string; language: string } } }) => {
        const row = rows.get(key(args.where.userId_problemId_language));
        return row ? { userId: row.userId } : null;
      }),
      create: vi.fn(async (args: { data: Row }) => {
        if (rows.has(key(args.data))) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        rows.set(key(args.data), { ...args.data });
        return args.data;
      }),
    },
  };
  return { state, db, key };
});

vi.mock("@/lib/db", () => ({ db: h.db }));
vi.mock("@/lib/rate-limit", () => ({
  hitRateLimit: async () => ({ allowed: true }),
  DRAFT_SAVE_RATE_LIMIT: { limit: 60, windowMs: 60_000 },
}));

const { saveServerDraft } = await import("@/lib/drafts/server");

const USER = "user_1";
const PROBLEM = "prob_1";
const T = Date.now() - 60_000;

const save = (source: string, clientUpdatedAt: number) =>
  saveServerDraft(USER, { problemId: PROBLEM, language: "py312", source, clientUpdatedAt });

const stored = () => h.state.rows.get(`${USER}/${PROBLEM}/py312`);

beforeEach(() => {
  h.state.rows.clear();
  h.state.updateCalls = 0;
  h.state.raceRow = null;
  vi.clearAllMocks();
});

describe("a first save that loses the race to an older one", () => {
  it("still wins, because it is newer", async () => {
    // The older save's row appears in the window between this save's
    // conditional update and the read that follows it.
    h.state.raceRow = {
      userId: USER,
      problemId: PROBLEM,
      language: "py312",
      source: "older",
      clientUpdatedAt: new Date(T),
    };

    const result = await save("newer", T + 10);

    expect(result).toEqual({ saved: true });
    expect(stored()?.source).toBe("newer");
    expect(stored()?.clientUpdatedAt.getTime()).toBe(T + 10);
    // It took the second conditional update to settle it, which is the
    // whole point: one was not enough.
    expect(h.state.updateCalls).toBe(2);
  });

  it("does not create a second row for the same draft", async () => {
    h.state.raceRow = {
      userId: USER,
      problemId: PROBLEM,
      language: "py312",
      source: "older",
      clientUpdatedAt: new Date(T),
    };
    await save("newer", T + 10);
    expect(h.state.rows.size).toBe(1);
  });
});

describe("and the no-op it must not become", () => {
  it("leaves a genuinely newer draft alone", async () => {
    // No race here: the stored row is simply newer than this save, which
    // is a stale beacon from a tab left open. Retrying the update must not
    // turn that into an overwrite.
    h.state.rows.set(`${USER}/${PROBLEM}/py312`, {
      userId: USER,
      problemId: PROBLEM,
      language: "py312",
      source: "newest",
      clientUpdatedAt: new Date(T + 1_000),
    });

    const result = await save("stale", T);

    expect(result).toEqual({ saved: false });
    expect(stored()?.source).toBe("newest");
    expect(h.db.codeDraft.create).not.toHaveBeenCalled();
  });

  it("writes an ordinary first save without any of this", async () => {
    const result = await save("first", T);
    expect(result).toEqual({ saved: true });
    expect(stored()?.source).toBe("first");
    expect(h.db.codeDraft.create).toHaveBeenCalledTimes(1);
  });

  it("overwrites an older stored draft on the first update, as it always did", async () => {
    h.state.rows.set(`${USER}/${PROBLEM}/py312`, {
      userId: USER,
      problemId: PROBLEM,
      language: "py312",
      source: "older",
      clientUpdatedAt: new Date(T),
    });
    const result = await save("newer", T + 10);
    expect(result).toEqual({ saved: true });
    expect(stored()?.source).toBe("newer");
    expect(h.state.updateCalls).toBe(1);
    expect(h.db.codeDraft.findUnique).not.toHaveBeenCalled();
  });
});
