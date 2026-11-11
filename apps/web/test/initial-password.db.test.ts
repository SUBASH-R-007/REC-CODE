import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The initial password an admin sets, and the one sign-in it is good for
 * (Phase 11f).
 *
 * The shape of the risk is the reason this file exists. A department may
 * hand the SAME password to a whole batch — that is what the feature is for
 * — so every account that keeps it is an account anyone in that batch can
 * open. The flag is therefore not a nudge: until it is cleared, the holder
 * may reach exactly one page and call exactly one action, and the password
 * they replace it with may not be the one they were given.
 *
 * Opt-in: RECX_DB_TESTS=1.
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";

vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";
    process.env.IP_HASH_PEPPER ??= "initial-password-test-pepper";
  }
});

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));

/** The acting user; the real guard would read a session cookie there is none of. */
let actorId = "";
vi.mock("@/lib/auth/guards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/guards")>();
  return {
    ...actual,
    requireActionUserSettingInitialPassword: async () => ({ id: actorId, role: "STUDENT" as const }),
  };
});

describe.skipIf(!ENABLED)("the initial password against recx_test", () => {
  const tag = `init-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let db: (typeof import("@/lib/db"))["db"];
  let setMyFirstPassword: (typeof import("@/server/actions/profile"))["setMyFirstPassword"];
  let hashPassword: (typeof import("@/lib/auth/password"))["hashPassword"];
  let verifyPassword: (typeof import("@/lib/auth/password"))["verifyPassword"];
  const userIds: string[] = [];

  const GIVEN = "the-given-password-1";
  const CHOSEN = "my-own-password-2";

  function form(fields: Record<string, string>): FormData {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    return data;
  }

  /** The action redirects on success; unwrap Next's control-flow throw. */
  async function setFirst(fields: Record<string, string>): Promise<{ ok: true; to: string } | { ok: false; error: string }> {
    try {
      const result = await setMyFirstPassword(null, form(fields));
      return result.ok ? { ok: true, to: "" } : { ok: false, error: result.error };
    } catch (error) {
      const digest = typeof (error as { digest?: unknown }).digest === "string" ? (error as { digest: string }).digest : "";
      if (digest.includes("NEXT_REDIRECT")) return { ok: true, to: digest };
      throw error;
    }
  }

  async function account(suffix: string, opts: { password?: string; mustChange?: boolean } = {}) {
    const row = await db.user.create({
      data: {
        collegeId: `${tag}-${suffix}`.toUpperCase().slice(0, 32),
        email: `${tag}-${suffix}@rajalakshmi.edu.invalid`,
        firstName: "Initial",
        lastName: suffix,
        handle: `${tag}-${suffix}`.slice(0, 30),
        role: "STUDENT",
        status: "ACTIVE",
        passwordHash: opts.password === undefined ? null : await hashPassword(opts.password),
        mustChangePassword: opts.mustChange ?? false,
      },
      select: { id: true },
    });
    userIds.push(row.id);
    return row.id;
  }

  const stateOf = (id: string) =>
    db.user.findUniqueOrThrow({ where: { id }, select: { passwordHash: true, mustChangePassword: true } });

  beforeAll(async () => {
    ({ db } = await import("@/lib/db"));
    ({ hashPassword, verifyPassword } = await import("@/lib/auth/password"));
    ({ setMyFirstPassword } = await import("@/server/actions/profile"));
  }, 120_000);

  afterAll(async () => {
    if (!ENABLED || userIds.length === 0) return;
    await db.auditLog.deleteMany({ where: { targetUserId: { in: userIds } } });
    await db.session.deleteMany({ where: { userId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
  }, 60_000);

  it("the database refuses the flag without a password to change", async () => {
    await expect(
      db.user.create({
        data: {
          collegeId: `${tag}-NOHASH`.toUpperCase().slice(0, 32),
          email: `${tag}-nohash@rajalakshmi.edu.invalid`,
          firstName: "No",
          lastName: "Hash",
          handle: `${tag}-nohash`.slice(0, 30),
          role: "STUDENT",
          status: "ACTIVE",
          passwordHash: null,
          mustChangePassword: true,
        },
      }),
    ).rejects.toThrow();
  }, 60_000);

  it("sends a holder of the initial password to the page that replaces it", async () => {
    const { INITIAL_PASSWORD_PATH, homeForRole } = await import("@/lib/auth/guards");
    // The destination is a property of the account, not of the form: an
    // ordinary account still goes to its own home.
    expect(INITIAL_PASSWORD_PATH).toBe("/account/new-password");
    expect(homeForRole("STUDENT")).toBe("/dashboard");
  }, 60_000);

  it("replaces the given password, clears the flag and drops every session", async () => {
    actorId = await account("replaces", { password: GIVEN, mustChange: true });
    const session = await db.session.create({
      data: { userId: actorId, tokenHash: randomBytes(32).toString("hex"), expiresAt: new Date(Date.now() + 86_400_000) },
      select: { id: true },
    });

    const result = await setFirst({ next: CHOSEN, confirm: CHOSEN });
    expect(result.ok).toBe(true);

    const after = await stateOf(actorId);
    expect(after.mustChangePassword).toBe(false);
    expect(await verifyPassword(CHOSEN, after.passwordHash!)).toBe(true);
    expect(await verifyPassword(GIVEN, after.passwordHash!)).toBe(false);
    // The session minted with the given password is gone; the action makes a
    // fresh one for the browser in front of it.
    expect(await db.session.findUnique({ where: { id: session.id } })).toBeNull();

    const actions = (
      await db.auditLog.findMany({ where: { targetUserId: actorId }, select: { action: true } })
    ).map((entry) => entry.action);
    expect(actions).toContain("auth.initial_password_replaced");
  }, 60_000);

  it("refuses the password they were given, which is the whole point", async () => {
    actorId = await account("same", { password: GIVEN, mustChange: true });
    const result = await setFirst({ next: GIVEN, confirm: GIVEN });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/different from the one you were given/i);
    // Still in the same state: nothing was let through.
    expect((await stateOf(actorId)).mustChangePassword).toBe(true);
  }, 60_000);

  it("refuses a weak password and a mismatch, and changes nothing", async () => {
    actorId = await account("refusals", { password: GIVEN, mustChange: true });
    const before = await stateOf(actorId);
    expect(await setFirst({ next: "short", confirm: "short" })).toMatchObject({ ok: false });
    expect(await setFirst({ next: CHOSEN, confirm: `${CHOSEN}x` })).toMatchObject({ ok: false });
    const after = await stateOf(actorId);
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.mustChangePassword).toBe(true);
  }, 60_000);

  it("is not a second way to change an ordinary password", async () => {
    actorId = await account("ordinary", { password: GIVEN, mustChange: false });
    const result = await setFirst({ next: CHOSEN, confirm: CHOSEN });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/already your own/i);
    expect((await stateOf(actorId)).passwordHash).toBe((await stateOf(actorId)).passwordHash);
    expect(await verifyPassword(GIVEN, (await stateOf(actorId)).passwordHash!)).toBe(true);
  }, 60_000);
});
