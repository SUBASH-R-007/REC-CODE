import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * saveProfileSettings with its boundaries faked: the guard, the database,
 * the audit log and the cache. Checks that a user edits only their own row,
 * that only visibility / opt-out changes are audited, that unknown editor
 * keys survive, and that bad input is a friendly ActionResult.
 */
const fakes = vi.hoisted(() => ({
  user: null as Record<string, unknown> | null,
  updates: [] as Array<{ where: unknown; data: Record<string, unknown> }>,
  audits: [] as Array<Record<string, unknown>>,
  revalidated: [] as string[],
}));

vi.mock("@/lib/auth/guards", () => ({
  requireActionUser: async () => {
    if (!fakes.user) {
      const { UnauthorizedError } = await import("@/lib/errors");
      throw new UnauthorizedError();
    }
    return fakes.user;
  },
}));
vi.mock("@/lib/db", () => ({
  db: {
    user: {
      update: async (args: { where: unknown; data: Record<string, unknown> }) => {
        fakes.updates.push(args);
        return {};
      },
    },
  },
}));
vi.mock("@/lib/audit", () => ({
  audit: async (entry: Record<string, unknown>) => {
    fakes.audits.push(entry);
  },
}));
vi.mock("@/lib/ip", () => ({ requestIpHash: async () => "ip-hash" }));
vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => {
    fakes.revalidated.push(path);
  },
}));

const { saveProfileSettings } = await import("@/server/actions/profile");

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

const BASE = { visibility: "REC_ONLY", bio: "", fontSize: "14", tabSize: "4" };

describe("saveProfileSettings", () => {
  beforeEach(() => {
    fakes.user = {
      id: "user-1",
      handle: "priya-s",
      visibility: "REC_ONLY",
      leaderboardOptOut: false,
      bio: null,
      editorPrefs: { keymap: "vim", fontSize: 13 },
    };
    fakes.updates.length = 0;
    fakes.audits.length = 0;
    fakes.revalidated.length = 0;
  });

  it("refuses a signed-out caller", async () => {
    fakes.user = null;
    const result = await saveProfileSettings(null, form(BASE));
    expect(result).toEqual({ ok: false, error: "You need to sign in to do that." });
    expect(fakes.updates).toEqual([]);
  });

  it("updates only the caller's row and keeps editor keys it does not own", async () => {
    const result = await saveProfileSettings(null, form({ ...BASE, bio: " Hello ", fontSize: "18", tabSize: "2" }));
    expect(result).toEqual({
      ok: true,
      data: { visibility: "REC_ONLY", leaderboardOptOut: false, bio: "Hello", fontSize: 18, tabSize: 2 },
    });
    expect(fakes.updates).toEqual([
      {
        where: { id: "user-1" },
        data: {
          visibility: "REC_ONLY",
          leaderboardOptOut: false,
          bio: "Hello",
          editorPrefs: { keymap: "vim", fontSize: 18, tabSize: 2 },
        },
      },
    ]);
    expect(fakes.audits).toEqual([]);
    expect(fakes.revalidated).toEqual(["/profile", "/u/priya-s", "/leaderboard"]);
  });

  it("stores an empty bio as null", async () => {
    await saveProfileSettings(null, form({ ...BASE, bio: "   " }));
    expect(fakes.updates[0]?.data.bio).toBeNull();
  });

  it("audits visibility and leaderboard opt-out changes", async () => {
    const result = await saveProfileSettings(null, form({ ...BASE, visibility: "PRIVATE", leaderboardOptOut: "on" }));
    expect(result.ok).toBe(true);
    expect(fakes.audits).toEqual([
      expect.objectContaining({
        actorId: "user-1",
        targetUserId: "user-1",
        action: "profile.visibility.changed",
        entityType: "User",
        metadata: { from: "REC_ONLY", to: "PRIVATE" },
        ipHash: "ip-hash",
      }),
      expect.objectContaining({
        action: "profile.leaderboard_opt_out.changed",
        metadata: { from: false, to: true },
      }),
    ]);
  });

  it("returns a readable error for invalid input and writes nothing", async () => {
    const result = await saveProfileSettings(null, form({ ...BASE, tabSize: "8" }));
    expect(result).toEqual({ ok: false, error: "The tab size must be 2 or 4 spaces." });
    const tooLong = await saveProfileSettings(null, form({ ...BASE, bio: "a".repeat(281) }));
    expect(tooLong).toEqual({ ok: false, error: "Keep your bio to 280 characters or fewer." });
    expect(fakes.updates).toEqual([]);
  });
});
