import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * `signInWithLmsSubject` against recx_test (Phase 16i).
 *
 * The provider half is proven over a socket in `oidc-provider.test.ts`;
 * what is left is the only part that touches an account, and it is the part
 * where the product's rules live rather than the protocol's:
 *
 *   * a subject the roster does not know gets NO account — this sign-in
 *     never creates one, and `/admin/students/import` stays the only thing
 *     that does;
 *   * a suspended or graduated account is refused, and the refusal is
 *     audited against that account so a coordinator can see the attempt;
 *   * the session is ROTATED, not added to, so a shared browser does not
 *     end up holding two;
 *   * the audit row says `via: "lms"`, because a reader of the log should
 *     not have to infer which door was used from what is missing;
 *   * `mustChangePassword` is ignored on purpose: that flag is about a
 *     password this person did not choose, and they have just proved
 *     themselves without using it.
 *
 * Opt-in: RECX_DB_TESTS=1. Every row this file reads is one it created
 * (the seed is not a fixture: CI never seeds).
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";

vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";
    process.env.IP_HASH_PEPPER ??= "lms-sign-in-test-pepper";
  }
});

/** What the session helpers were asked to do, in order. */
const calls: string[] = [];
let cookieJar = new Map<string, string>();

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "a test" }),
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
    set: (name: string, value: string) => void cookieJar.set(name, value),
    delete: (name: string) => void cookieJar.delete(name),
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));

/**
 * The session helpers are the real ones for what they write to the
 * database, with the ORDER recorded: "destroy, then create" is the claim,
 * and a test that only checked the row count afterwards would pass if they
 * ran the other way round.
 */
vi.mock("@/lib/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/session")>();
  return {
    ...actual,
    destroySession: async () => {
      calls.push("destroy");
      return actual.destroySession();
    },
    createSession: async (userId: string, userAgent?: string | null) => {
      calls.push("create");
      return actual.createSession(userId, userAgent);
    },
  };
});

describe.skipIf(!ENABLED)("signing in with an LMS subject, against recx_test", () => {
  const tag = `lms-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let db: (typeof import("@/lib/db"))["db"];
  let signInWithLmsSubject: (typeof import("@/lib/auth/sign-in"))["signInWithLmsSubject"];
  let hashPassword: (typeof import("@/lib/auth/password"))["hashPassword"];
  const userIds: string[] = [];

  /** An account as the roster import would leave it: an lmsUserId, no password. */
  async function rosterAccount(
    suffix: string,
    options: {
      status?: "ACTIVE" | "SOFT_RESTRICTED" | "DISABLED" | "GRADUATED" | "ARCHIVED";
      role?: "STUDENT" | "ADMIN" | "TA_MENTOR" | "PLACEMENT_OFFICER" | "SUPER_ADMIN";
      lmsUserId?: string | null;
      password?: string;
      mustChange?: boolean;
    } = {},
  ): Promise<{ id: string; lmsUserId: string | null }> {
    const row = await db.user.create({
      data: {
        collegeId: `${tag}-${suffix}`.toUpperCase().slice(0, 32),
        email: `${tag}-${suffix}@rajalakshmi.edu.invalid`,
        firstName: "Roster",
        lastName: suffix,
        handle: `${tag}-${suffix}`.slice(0, 30),
        role: options.role ?? "STUDENT",
        status: options.status ?? "ACTIVE",
        lmsUserId: options.lmsUserId === undefined ? `${tag}-sub-${suffix}` : options.lmsUserId,
        passwordHash: options.password === undefined ? null : await hashPassword(options.password),
        mustChangePassword: options.mustChange ?? false,
      },
      select: { id: true, lmsUserId: true },
    });
    userIds.push(row.id);
    return row;
  }

  const auditFor = (id: string) =>
    db.auditLog.findMany({
      where: { targetUserId: id },
      orderBy: { createdAt: "asc" },
      select: { action: true, actorId: true, metadata: true, ipHash: true, sensitivity: true },
    });

  beforeAll(async () => {
    ({ db } = await import("@/lib/db"));
    ({ hashPassword } = await import("@/lib/auth/password"));
    ({ signInWithLmsSubject } = await import("@/lib/auth/sign-in"));
  }, 120_000);

  afterAll(async () => {
    if (!ENABLED || userIds.length === 0) return;
    await db.auditLog.deleteMany({ where: { targetUserId: { in: userIds } } });
    await db.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await db.session.deleteMany({ where: { userId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
  }, 60_000);

  it("signs in a roster account with no password at all and sends it to its home", async () => {
    // The account the roster import creates: `passwordHash: null`. Until
    // this phase it could not sign in at all, which is the gap Phase 16i
    // closes.
    const account = await rosterAccount("plain");
    calls.length = 0;
    cookieJar = new Map();

    const result = await signInWithLmsSubject(account.lmsUserId!);
    expect(result).toEqual({ ok: true, home: "/dashboard" });

    const sessions = await db.session.findMany({ where: { userId: account.id }, select: { id: true } });
    expect(sessions).toHaveLength(1);
    expect(calls).toEqual(["destroy", "create"]);

    const fresh = await db.user.findUniqueOrThrow({
      where: { id: account.id },
      select: { lastLoginAt: true, passwordHash: true },
    });
    expect(fresh.lastLoginAt).not.toBeNull();
    // And it did not quietly give the account a password.
    expect(fresh.passwordHash).toBeNull();
  }, 60_000);

  it("audits the sign-in as auth.login with via: lms, and a hashed IP", async () => {
    const account = await rosterAccount("audited");
    await signInWithLmsSubject(account.lmsUserId!);

    const rows = await db.auditLog.findMany({
      where: { actorId: account.id, action: "auth.login" },
      select: { metadata: true, ipHash: true, entityType: true, entityId: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toMatchObject({ via: "lms" });
    expect(rows[0]!.entityType).toBe("User");
    expect(rows[0]!.entityId).toBe(account.id);
    // Never a raw address. In this process there is no client address at
    // all, so the column is null rather than a hash of nothing — what must
    // never appear is something that looks like an address.
    expect(rows[0]!.ipHash ?? "").not.toMatch(/\d+\.\d+\.\d+\.\d+/);

    // And the subject from the other system is not in the row: it
    // identifies this person in a directory this platform does not own.
    expect(JSON.stringify(rows[0]!.metadata)).not.toContain(account.lmsUserId!);
  }, 60_000);

  it("refuses a subject the roster does not know, and creates NOTHING", async () => {
    const before = await db.user.count();
    const stranger = `${tag}-nobody-at-all`;

    expect(await signInWithLmsSubject(stranger)).toEqual({ ok: false, failure: "not-enrolled" });

    expect(await db.user.count()).toBe(before);
    expect(await db.user.findUnique({ where: { lmsUserId: stranger }, select: { id: true } })).toBeNull();
    // Not audited either: there is no user to audit it against, and the
    // subject is an identifier from another system for somebody this one
    // does not know.
    const rows = await db.auditLog.findMany({
      where: { action: "auth.login_failed", createdAt: { gte: new Date(Date.now() - 60_000) } },
      select: { metadata: true },
    });
    for (const row of rows) expect(JSON.stringify(row.metadata)).not.toContain(stranger);
  }, 60_000);

  it("signs in a SOFT_RESTRICTED account: the restriction is not a ban from the door", async () => {
    // `SIGN_IN_STATUSES` is ACTIVE and SOFT_RESTRICTED, and this door uses
    // the same set as the password one -- a restriction limits what an
    // account may DO, and a second definition of "may sign in" is how two
    // doors drift apart.
    const account = await rosterAccount("soft", { status: "SOFT_RESTRICTED" });
    expect(await signInWithLmsSubject(account.lmsUserId!)).toEqual({ ok: true, home: "/dashboard" });
  }, 60_000);

  it.each(["DISABLED", "GRADUATED", "ARCHIVED"] as const)("refuses a %s account, and audits the attempt", async (status) => {
    const account = await rosterAccount(`st-${status.toLowerCase()}`, { status });
    calls.length = 0;

    expect(await signInWithLmsSubject(account.lmsUserId!)).toEqual({ ok: false, failure: "inactive" });

    // No session, and the rotation never started: a refused sign-in must
    // not sign somebody OUT of a session they already had.
    expect(await db.session.count({ where: { userId: account.id } })).toBe(0);
    expect(calls).toEqual([]);

    const rows = await auditFor(account.id);
    expect(rows.map((r) => r.action)).toEqual(["auth.login_failed"]);
    expect(rows[0]!.actorId).toBeNull();
    expect(rows[0]!.sensitivity).toBe("SECURITY");
    expect(rows[0]!.metadata).toMatchObject({ via: "lms" });
  }, 60_000);

  it("rotates THIS browser's session, and leaves another device's alone", async () => {
    const account = await rosterAccount("rotates");
    const { SESSION_COOKIE, hashSessionToken } = await import("@/lib/auth/session-token");

    // Two live sessions: one this browser carries, one from a phone.
    const carried = randomBytes(32).toString("base64url");
    const here = await db.session.create({
      data: {
        userId: account.id,
        tokenHash: hashSessionToken(carried),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
      select: { id: true },
    });
    const elsewhere = await db.session.create({
      data: {
        userId: account.id,
        tokenHash: hashSessionToken(randomBytes(32).toString("base64url")),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
      select: { id: true },
    });
    cookieJar = new Map([[SESSION_COOKIE, carried]]);

    await signInWithLmsSubject(account.lmsUserId!);

    const ids = (await db.session.findMany({ where: { userId: account.id }, select: { id: true } })).map((r) => r.id);
    // The one this browser held is gone, a new one took its place, and the
    // phone is still signed in -- signing in HERE is not a sign-out
    // everywhere, which is `destroySession`'s contract and not a detail of
    // this door.
    expect(ids).not.toContain(here.id);
    expect(ids).toContain(elsewhere.id);
    expect(ids).toHaveLength(2);
    expect(cookieJar.get(SESSION_COOKIE)).not.toBe(carried);
  }, 60_000);

  it("signs in a staff account to the staff home", async () => {
    // An LMS subject is not a student-only thing: the roster carries staff
    // too, and the destination is the role's, never the door's.
    const account = await rosterAccount("staff", { role: "ADMIN" });
    expect(await signInWithLmsSubject(account.lmsUserId!)).toEqual({ ok: true, home: "/admin" });
  }, 60_000);

  it("ignores mustChangePassword: this person did not use a password", async () => {
    // Deliberate. The flag means "replace the password you were handed",
    // and somebody who signed in through the LMS has not been handed one
    // to replace — sending them to /account/new-password would ask them to
    // invent a credential the platform did not want them to have.
    const account = await rosterAccount("mustchange", { password: "the-given-password-1", mustChange: true });
    expect(await signInWithLmsSubject(account.lmsUserId!)).toEqual({ ok: true, home: "/dashboard" });
    const fresh = await db.user.findUniqueOrThrow({
      where: { id: account.id },
      select: { mustChangePassword: true },
    });
    // And the flag is untouched: a later password sign-in still has to
    // replace it.
    expect(fresh.mustChangePassword).toBe(true);
  }, 60_000);

  it("an account with no lmsUserId cannot be reached by any subject", async () => {
    // The seed's staff accounts look like this, and so does anybody a
    // super-admin added by hand. An empty subject must not match them.
    const account = await rosterAccount("nosub", { lmsUserId: null, password: "a-password-1" });
    for (const subject of ["", " ", "null", "undefined"]) {
      expect(await signInWithLmsSubject(subject), subject).toEqual({ ok: false, failure: "not-enrolled" });
    }
    expect(await db.session.count({ where: { userId: account.id } })).toBe(0);
  }, 60_000);

  it("the subject must match exactly — no prefix, no case folding", async () => {
    const account = await rosterAccount("exact");
    const subject = account.lmsUserId!;
    for (const near of [subject.toUpperCase(), subject.slice(0, -1), `${subject}x`, ` ${subject}`, `${subject} `]) {
      expect(await signInWithLmsSubject(near), near).toEqual({ ok: false, failure: "not-enrolled" });
    }
    expect(await signInWithLmsSubject(subject)).toMatchObject({ ok: true });
  }, 60_000);
});
