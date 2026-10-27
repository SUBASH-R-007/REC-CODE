import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Setting a password through a one-time link, against the real table and
 * the real trigger (Phase 11a).
 *
 * The promises being tested are the ones that would be easy to lose in a
 * later refactor and expensive to lose in production:
 *
 *   * the token is not in the database — only its sha256;
 *   * a link works once, and asking again kills the earlier one;
 *   * spending one ends every session of the account;
 *   * a weak password is refused WITHOUT spending the link, so a mistyped
 *     password does not cost somebody their only way in;
 *   * and the database refuses to un-spend a link whatever the application
 *     asks it to do.
 *
 * Opt-in: RECX_DB_TESTS=1 (RECX_TEST_DATABASE_URL overrides the URL; it must
 * name a *_test database).
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";

vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";
    process.env.IP_HASH_PEPPER ??= "password-reset-test-pepper";
    process.env.APP_URL ??= "http://localhost:3000";
  }
});

/** The request helpers read headers(); nothing here is a request. */
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));

describe.skipIf(!ENABLED)("password reset against recx_test", () => {
  const tag = `reset-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let db: (typeof import("@/lib/db"))["db"];
  let lib: typeof import("@/lib/auth/password-reset");
  let verifyPassword: (typeof import("@/lib/auth/password"))["verifyPassword"];
  const userIds: string[] = [];

  /** A student with no password at all — exactly what a roster import creates. */
  async function account(suffix: string, extra: { role?: "STUDENT" | "SUPER_ADMIN"; status?: "ACTIVE" | "DISABLED" } = {}) {
    const row = await db.user.create({
      data: {
        collegeId: `${tag}-${suffix}`.toUpperCase().slice(0, 32),
        email: `${tag}-${suffix}@rajalakshmi.edu.invalid`,
        firstName: "Reset",
        lastName: suffix,
        handle: `${tag}-${suffix}`.slice(0, 30),
        role: extra.role ?? "STUDENT",
        status: extra.status ?? "ACTIVE",
        passwordHash: null,
      },
      select: { id: true, email: true, collegeId: true },
    });
    userIds.push(row.id);
    return row;
  }

  const resets = (userId: string) =>
    db.passwordReset.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });

  const mailFor = (userId: string) =>
    db.emailOutbox.findMany({ where: { toUserId: userId }, orderBy: { createdAt: "asc" } });

  beforeAll(async () => {
    ({ db } = await import("@/lib/db"));
    lib = await import("@/lib/auth/password-reset");
    ({ verifyPassword } = await import("@/lib/auth/password"));
  }, 60_000);

  afterAll(async () => {
    if (!ENABLED || userIds.length === 0) return;
    await db.emailOutbox.deleteMany({ where: { toUserId: { in: userIds } } });
    await db.auditLog.deleteMany({ where: { targetUserId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
  }, 60_000);

  it("stores only the token's hash, with an hour on it, and queues one mail", async () => {
    const user = await account("basic");
    expect(await lib.requestPasswordReset({ identifier: user.collegeId, ipHash: "a".repeat(64) })).toEqual({
      queued: true,
    });

    const rows = await resets(user.id);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.consumedAt).toBeNull();
    expect(row.requestIpHash).toBe("a".repeat(64));
    const minutes = (row.expiresAt.getTime() - row.createdAt.getTime()) / 60_000;
    expect(minutes).toBeCloseTo(lib.RESET_TTL_MINUTES, 0);

    const mail = await mailFor(user.id);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.kind).toBe(lib.RESET_EMAIL_KIND);
    // The link is in the body; the token is NOT in the row that stores it.
    expect(mail[0]!.bodyText).toContain("/reset-password?token=");
    const line = mail[0]!.bodyText.split("\n").find((l) => l.includes("/reset-password?token="))!;
    const token = new URL(line).searchParams.get("token") ?? "";
    expect(token).not.toBe("");
    expect(row.tokenHash).not.toBe(token);
    expect(row.tokenHash).toBe(lib.hashResetToken(token));
    // A link, and nothing a reader could mistake for a password.
    expect(mail[0]!.bodyText).not.toMatch(/temporary password|your password is/i);
  }, 60_000);

  it("says nothing and queues nothing for an identifier with no account, or one that may not sign in", async () => {
    expect(await lib.requestPasswordReset({ identifier: `${tag}-nobody`, ipHash: null })).toEqual({ queued: false });

    const restricted = await account("disabled", { status: "DISABLED" });
    expect(await lib.requestPasswordReset({ identifier: restricted.email, ipHash: null })).toEqual({ queued: false });
    expect(await resets(restricted.id)).toHaveLength(0);
    expect(await mailFor(restricted.id)).toHaveLength(0);
  }, 60_000);

  /** Ask, then read the token out of the queued mail, as a person would out of their inbox. */
  async function linkFor(userId: string, identifier: string): Promise<string> {
    const before = (await mailFor(userId)).length;
    await lib.requestPasswordReset({ identifier, ipHash: null });
    const mail = await mailFor(userId);
    expect(mail.length).toBe(before + 1);
    const line = mail.at(-1)!.bodyText.split("\n").find((l) => l.includes("/reset-password?token="))!;
    return new URL(line).searchParams.get("token")!;
  }

  it("sets the password, ends every session, and audits it", async () => {
    const user = await account("sets");
    const token = await linkFor(user.id, user.collegeId);

    // A live session, which the reset must remove.
    const session = await db.session.create({
      data: {
        userId: user.id,
        tokenHash: randomBytes(32).toString("hex"),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
      select: { id: true },
    });

    expect(await lib.completePasswordReset({ token, password: "a-good-password-1", ipHash: null })).toEqual({
      ok: true,
    });

    const after = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { passwordHash: true } });
    expect(after.passwordHash).not.toBeNull();
    expect(await verifyPassword("a-good-password-1", after.passwordHash!)).toBe(true);
    expect(await db.session.findUnique({ where: { id: session.id } })).toBeNull();
    expect((await resets(user.id)).at(-1)!.consumedAt).not.toBeNull();

    const entries = await db.auditLog.findMany({ where: { targetUserId: user.id }, select: { action: true } });
    expect(entries.map((e) => e.action).sort()).toEqual([
      "auth.password_reset_completed",
      "auth.password_reset_requested",
    ]);
  }, 60_000);

  it("spends a link once, and asking again kills the one before it", async () => {
    const user = await account("once");
    const first = await linkFor(user.id, user.collegeId);
    expect(await lib.completePasswordReset({ token: first, password: "first-password-1", ipHash: null })).toEqual({
      ok: true,
    });
    // Second use of the same link.
    expect(await lib.completePasswordReset({ token: first, password: "second-password-1", ipHash: null })).toEqual({
      ok: false,
      failure: "invalid",
    });

    const second = await linkFor(user.id, user.collegeId);
    const third = await linkFor(user.id, user.collegeId);
    // Asking a third time superseded the second link.
    expect(await lib.completePasswordReset({ token: second, password: "third-password-1", ipHash: null })).toEqual({
      ok: false,
      failure: "invalid",
    });
    expect(await lib.completePasswordReset({ token: third, password: "fourth-password-1", ipHash: null })).toEqual({
      ok: true,
    });
  }, 60_000);

  it("refuses an expired link", async () => {
    const user = await account("expired");
    const token = await linkFor(user.id, user.collegeId);
    // Age it by moving the row's window into the past. The trigger forbids
    // changing expiresAt, so the row is replaced the way a clock would have
    // left it: created an hour and a half ago, expired half an hour ago.
    const row = (await resets(user.id)).at(-1)!;
    await db.$executeRaw`DELETE FROM "PasswordReset" WHERE id = ${row.id}`;
    const past = new Date(Date.now() - 90 * 60_000);
    await db.$executeRaw`
      INSERT INTO "PasswordReset" ("id", "userId", "tokenHash", "expiresAt", "createdAt")
      VALUES (${row.id}, ${user.id}, ${row.tokenHash}, ${new Date(past.getTime() + 60 * 60_000)}, ${past})`;

    expect(await lib.completePasswordReset({ token, password: "expired-password-1", ipHash: null })).toEqual({
      ok: false,
      failure: "invalid",
    });
  }, 60_000);

  it("refuses a weak password without spending the link", async () => {
    const user = await account("weak");
    const token = await linkFor(user.id, user.collegeId);
    expect(await lib.completePasswordReset({ token, password: "short", ipHash: null })).toEqual({
      ok: false,
      failure: "weak",
    });
    expect((await resets(user.id)).at(-1)!.consumedAt).toBeNull();
    // Still usable, which is the point: a typo must not cost the only link.
    expect(await lib.completePasswordReset({ token, password: "a-good-password-2", ipHash: null })).toEqual({
      ok: true,
    });
  }, 60_000);

  it("tells every super-admin when a super-admin's password is set this way", async () => {
    const admin = await account("super", { role: "SUPER_ADMIN" });
    const token = await linkFor(admin.id, admin.collegeId);
    expect(await lib.completePasswordReset({ token, password: "super-password-11", ipHash: null })).toEqual({
      ok: true,
    });
    const kinds = (await mailFor(admin.id)).map((m) => m.kind);
    expect(kinds).toContain(lib.RESET_EMAIL_KIND_SUPER);
  }, 60_000);

  describe("the database refuses what the application must not do", () => {
    it("will not un-spend a link", async () => {
      const user = await account("unspend");
      const token = await linkFor(user.id, user.collegeId);
      await lib.completePasswordReset({ token, password: "a-good-password-3", ipHash: null });
      const row = (await resets(user.id)).at(-1)!;
      await expect(
        db.$executeRaw`UPDATE "PasswordReset" SET "consumedAt" = NULL WHERE id = ${row.id}`,
      ).rejects.toThrow(/stays spent/);
    }, 60_000);

    it("will not move a link to another account or another token", async () => {
      const [a, b] = [await account("move-a"), await account("move-b")];
      await linkFor(a.id, a.collegeId);
      const row = (await resets(a.id)).at(-1)!;
      await expect(
        db.$executeRaw`UPDATE "PasswordReset" SET "userId" = ${b.id} WHERE id = ${row.id}`,
      ).rejects.toThrow(/another account or token/);
      await expect(
        db.$executeRaw`UPDATE "PasswordReset" SET "tokenHash" = ${"b".repeat(64)} WHERE id = ${row.id}`,
      ).rejects.toThrow(/another account or token/);
    }, 60_000);

    it("will not create a link that could never be spent", async () => {
      const user = await account("window");
      await expect(
        db.$executeRaw`
          INSERT INTO "PasswordReset" ("id", "userId", "tokenHash", "expiresAt", "createdAt")
          VALUES (${`${tag}-bad`}, ${user.id}, ${"c".repeat(64)}, ${new Date(Date.now() - 60_000)}, ${new Date()})`,
      ).rejects.toThrow(/PasswordReset_window_check/);
    }, 60_000);
  });
});
