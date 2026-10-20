import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@recx/db";

/**
 * Notes actions against a real Postgres (recx_test): a student only ever
 * reads, edits or deletes their own notes; links go to published problems
 * only; deletion is audited without content; the 64 KB cap holds.
 *
 * Opt-in: RECX_DB_TESTS=1 (RECX_TEST_DATABASE_URL overrides the URL; it must
 * name a *_test database). The session, cache revalidation, rate limiter and
 * audit chain are replaced by in-memory fakes.
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";
const TEST_URL = process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";

const state = vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";
  }
  return { user: null as unknown, audits: [] as Array<Record<string, unknown>> };
});

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: async () => state.user }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));
vi.mock("@/lib/rate-limit", () => ({
  hitRateLimit: async () => ({ allowed: true, remaining: 1, retryAfterMs: 0, key: "k", member: "m", failedOpen: true }),
}));
vi.mock("@/lib/audit", () => ({
  audit: async (entry: Record<string, unknown>) => {
    state.audits.push(entry);
  },
}));

type Modules = {
  db: (typeof import("@/lib/db"))["db"];
  notes: typeof import("@/server/actions/notes");
  data: typeof import("@/app/(student)/notes/data");
};

describe.skipIf(!ENABLED)("notes actions against recx_test", () => {
  const tag = `notes-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let m: Modules;
  let alice: User;
  let bob: User;
  let publishedId = "";
  let draftId = "";
  const problemIds: string[] = [];

  const as = (user: User | null) => {
    state.user = user;
  };

  beforeAll(async () => {
    if (!new URL(TEST_URL).pathname.endsWith("_test")) {
      throw new Error(`Refusing to run against a non-test database: ${new URL(TEST_URL).pathname}`);
    }
    const [dbModule, notes, data] = await Promise.all([
      import("@/lib/db"),
      import("@/server/actions/notes"),
      import("@/app/(student)/notes/data"),
    ]);
    m = { db: dbModule.db, notes, data };

    const mkUser = (suffix: string, firstName: string) =>
      m.db.user.create({
        data: {
          collegeId: `${tag}-${suffix}`,
          email: `${tag}-${suffix}@rec-code.example`,
          handle: `${tag}-${suffix}`,
          firstName,
          lastName: "Tester",
        },
      });
    alice = await mkUser("a", "Alice");
    bob = await mkUser("b", "Bob");

    const published = await m.db.problem.create({
      data: { slug: `${tag}-pub`, displayCode: `${tag}-P1`, title: "Notes test problem", difficulty: "EASY", status: "PUBLISHED" },
      select: { id: true },
    });
    const version = await m.db.problemVersion.create({
      data: {
        problemId: published.id,
        revision: 1,
        title: "Notes test problem",
        difficulty: "EASY",
        statementMd: "Test.",
        ioMode: "STDIN",
        timeLimitMs: 1000,
      },
      select: { id: true },
    });
    await m.db.problem.update({ where: { id: published.id }, data: { liveVersionId: version.id } });
    const draft = await m.db.problem.create({
      data: { slug: `${tag}-draft`, displayCode: `${tag}-P2`, title: "Draft problem", difficulty: "HARD" },
      select: { id: true },
    });
    publishedId = published.id;
    draftId = draft.id;
    problemIds.push(published.id, draft.id);
  }, 60_000);

  afterAll(async () => {
    if (!m) return;
    try {
      await m.db.note.deleteMany({ where: { userId: { in: [alice.id, bob.id] } } });
      await m.db.problem.updateMany({ where: { id: { in: problemIds } }, data: { liveVersionId: null } });
      await m.db.problemVersion.deleteMany({ where: { problemId: { in: problemIds } } });
      await m.db.problem.deleteMany({ where: { id: { in: problemIds } } });
      await m.db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    } finally {
      await m.db.$disconnect();
    }
  }, 60_000);

  beforeEach(() => {
    state.audits.length = 0;
  });

  it("refuses every action without a session", async () => {
    as(null);
    const created = await m.notes.createNote({ contentMd: "hello" });
    expect(created.ok).toBe(false);
    const preview = await m.notes.previewNote({ contentMd: "hello" });
    expect(preview.ok).toBe(false);
  });

  it("keeps each student's notes private: read, edit and delete", async () => {
    as(alice);
    const created = await m.notes.createNote({ title: "Mine", contentMd: "secret plan", problemId: publishedId });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.data.id;

    expect(await m.data.getOwnNote(id, alice.id)).toMatchObject({ title: "Mine", problemId: publishedId });
    expect(await m.data.getOwnNote(id, bob.id)).toBeNull();

    as(bob);
    const edit = await m.notes.updateNote({ id, contentMd: "overwritten" });
    expect(edit).toEqual({ ok: false, error: expect.stringMatching(/not found/i) });
    const del = await m.notes.deleteNote({ id });
    expect(del).toEqual({ ok: false, error: expect.stringMatching(/not found/i) });

    const row = await m.db.note.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ userId: alice.id, contentMd: "secret plan" });
    expect(state.audits).toHaveLength(0);
  });

  it("links only published problems, and keeps an existing link on edit", async () => {
    as(alice);
    const draftLink = await m.notes.createNote({ contentMd: "x", problemId: draftId });
    expect(draftLink.ok).toBe(false);
    const missing = await m.notes.createNote({ contentMd: "x", problemId: "does-not-exist" });
    expect(missing.ok).toBe(false);

    const ok = await m.notes.createNote({ contentMd: "linked", problemId: publishedId });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    const updated = await m.notes.updateNote({ id: ok.data.id, title: "  Renamed ", contentMd: "linked v2", problemId: publishedId });
    expect(updated.ok).toBe(true);
    expect(await m.db.note.findUniqueOrThrow({ where: { id: ok.data.id } })).toMatchObject({
      title: "Renamed",
      contentMd: "linked v2",
      problemId: publishedId,
    });
    const unlinked = await m.notes.updateNote({ id: ok.data.id, contentMd: "no link", problemId: null });
    expect(unlinked.ok).toBe(true);
    expect((await m.db.note.findUniqueOrThrow({ where: { id: ok.data.id } })).problemId).toBeNull();
  });

  it("enforces the 64 KB cap on the server", async () => {
    as(alice);
    const big = await m.notes.createNote({ contentMd: "a".repeat(64 * 1024 + 1) });
    expect(big).toEqual({ ok: false, error: expect.stringMatching(/64 KB/) });
  });

  it("deletes the owner's note and audits it without its content", async () => {
    as(alice);
    const created = await m.notes.createNote({ title: "Temp", contentMd: "to be deleted" });
    if (!created.ok) throw new Error(created.error);
    const del = await m.notes.deleteNote({ id: created.data.id });
    expect(del).toEqual({ ok: true, data: null });
    expect(await m.db.note.findUnique({ where: { id: created.data.id } })).toBeNull();
    expect(state.audits).toEqual([
      expect.objectContaining({ action: "note.deleted", entityType: "Note", entityId: created.data.id, actorId: alice.id }),
    ]);
    expect(JSON.stringify(state.audits)).not.toContain("to be deleted");
  });

  it("previews through the sanitised renderer", async () => {
    as(alice);
    const preview = await m.notes.previewNote({ contentMd: "**bold** <script>alert(1)</script>" });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.data.html).toContain("<strong>bold</strong>");
    expect(preview.data.html).not.toContain("<script");
  });
});
