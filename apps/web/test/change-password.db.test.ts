import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Changing a password you already know (`profile#changeMyPassword`,
 * Phase 11b) — the other half of the gap Phase 11a opened on: there had
 * never been a way for anybody, student or super-admin, to change their own
 * password.
 *
 * The cases that matter are the refusals. A change that did not need the
 * current password would turn any unlocked laptop in a lab into a permanent
 * takeover, and a change that left the other sessions alive would leave
 * whoever prompted the change still signed in.
 *
 * Opt-in: RECX_DB_TESTS=1.
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";

vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";
    process.env.IP_HASH_PEPPER ??= "change-password-test-pepper";
  }
});

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));

/** The acting user; the guard is replaced because a session is not the subject here. */
let actorId = "";
vi.mock("@/lib/auth/guards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/guards")>();
  return { ...actual, requireActionUser: async () => ({ id: actorId, role: "STUDENT" as const }) };
});

describe.skipIf(!ENABLED)("changing your own password against recx_test", () => {
  const tag = `chg-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let db: (typeof import("@/lib/db"))["db"];
  let changeMyPassword: (typeof import("@/server/actions/profile"))["changeMyPassword"];
  let hashPassword: (typeof import("@/lib/auth/password"))["hashPassword"];
  let verifyPassword: (typeof import("@/lib/auth/password"))["verifyPassword"];
  const userIds: string[] = [];

  const OLD = "the-old-password-1";
  const NEW = "the-new-password-2";

  function form(fields: Record<string, string>): FormData {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    return data;
  }

  /** The action redirects on success; unwrap Next's control-flow throw. */
  async function change(fields: Record<string, string>): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const result = await changeMyPassword(null, form(fields));
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    } catch (error) {
      const digest = typeof (error as { digest?: unknown }).digest === "string" ? (error as { digest: string }).digest : "";
      if (digest.includes("/login")) return { ok: true };
      throw error;
    }
  }

  async function account(suffix: string, password: string | null) {
    const row = await db.user.create({
      data: {
        collegeId: `${tag}-${suffix}`.toUpperCase().slice(0, 32),
        email: `${tag}-${suffix}@rajalakshmi.edu.invalid`,
        firstName: "Change",
        lastName: suffix,
        handle: `${tag}-${suffix}`.slice(0, 30),
        role: "STUDENT",
        status: "ACTIVE",
        passwordHash: password === null ? null : await hashPassword(password),
      },
      select: { id: true },
    });
    userIds.push(row.id);
    return row.id;
  }

  const hashOf = async (id: string) =>
    (await db.user.findUniqueOrThrow({ where: { id }, select: { passwordHash: true } })).passwordHash;

  beforeAll(async () => {
    ({ db } = await import("@/lib/db"));
    ({ hashPassword, verifyPassword } = await import("@/lib/auth/password"));
    ({ changeMyPassword } = await import("@/server/actions/profile"));
  }, 120_000);

  afterAll(async () => {
    if (!ENABLED || userIds.length === 0) return;
    await db.auditLog.deleteMany({ where: { targetUserId: { in: userIds } } });
    await db.session.deleteMany({ where: { userId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
  }, 60_000);

  it("changes the password and ends every session, including this one", async () => {
    actorId = await account("works", OLD);
    const session = await db.session.create({
      data: { userId: actorId, tokenHash: randomBytes(32).toString("hex"), expiresAt: new Date(Date.now() + 86_400_000) },
      select: { id: true },
    });

    expect(await change({ current: OLD, next: NEW, confirm: NEW })).toEqual({ ok: true });

    const hash = await hashOf(actorId);
    expect(await verifyPassword(NEW, hash!)).toBe(true);
    expect(await verifyPassword(OLD, hash!)).toBe(false);
    expect(await db.session.findUnique({ where: { id: session.id } })).toBeNull();

    const actions = (
      await db.auditLog.findMany({ where: { targetUserId: actorId }, select: { action: true } })
    ).map((entry) => entry.action);
    expect(actions).toContain("auth.password_changed");
  }, 60_000);

  it("refuses a wrong current password, audits the attempt, and changes nothing", async () => {
    actorId = await account("wrong", OLD);
    const before = await hashOf(actorId);

    const result = await change({ current: "not-my-password", next: NEW, confirm: NEW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/current password/i);
    expect(await hashOf(actorId)).toBe(before);

    const actions = (
      await db.auditLog.findMany({ where: { targetUserId: actorId }, select: { action: true } })
    ).map((entry) => entry.action);
    // A failed attempt on a real account is worth a SECURITY row: this is
    // the shape of somebody at an unlocked machine.
    expect(actions).toContain("auth.password_change_failed");
  }, 60_000);

  it("refuses a weak password, a mismatch, and the password it already has", async () => {
    actorId = await account("refusals", OLD);
    const before = await hashOf(actorId);

    expect(await change({ current: OLD, next: "short", confirm: "short" })).toMatchObject({ ok: false });
    expect(await change({ current: OLD, next: NEW, confirm: `${NEW}x` })).toMatchObject({ ok: false });
    expect(await change({ current: OLD, next: OLD, confirm: OLD })).toMatchObject({ ok: false });
    expect(await hashOf(actorId)).toBe(before);
  }, 60_000);

  it("tells an account with no password where to get one", async () => {
    actorId = await account("none", null);
    const result = await change({ current: "anything", next: NEW, confirm: NEW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/sign-in page/i);
    expect(await hashOf(actorId)).toBeNull();
  }, 60_000);
});
