import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A second factor for privileged accounts, against recx_test (Phase 16j).
 *
 * `docs/ROADMAP.md` §3.1. What this file is for is the part no pure test can
 * reach: the four database guards, and the behaviour that depends on them.
 *
 *   * a code is good for ONE use, enforced by a monotonic `lastCounter`
 *     that a trigger refuses to let go backwards — so two requests racing
 *     with the same code cannot both succeed;
 *   * a spent recovery code stays spent, and cannot be moved to another
 *     account;
 *   * a challenge's attempt count never falls and its window never widens,
 *     so five tries is five tries rather than five per reset;
 *   * a credential belongs to an ADMIN or SUPER_ADMIN, and the database
 *     says so as well as the action.
 *
 * And the design decision the whole phase rests on: **a correct password
 * creates no Session.** Each refusal below asserts that too, because that
 * is what makes a forgotten guard impossible rather than unlikely.
 *
 * Opt-in: RECX_DB_TESTS=1. Every row read here is one this file created.
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";

vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";
    process.env.IP_HASH_PEPPER ??= "second-factor-test-pepper";
    // A key this test invents, for secrets this test makes.
    process.env.TOTP_ENCRYPTION_KEY ??= Buffer.alloc(32, 11).toString("base64");
  }
});

let cookieJar = new Map<string, string>();

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "a test" }),
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
    set: (name: string, value: string, options?: { maxAge?: number }) => {
      if (options?.maxAge === 0) cookieJar.delete(name);
      else cookieJar.set(name, value);
    },
    delete: (name: string) => void cookieJar.delete(name),
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));

/** The acting user for the enrolment actions; the real guard needs a session. */
let actorId = "";
let actorRole: "ADMIN" | "SUPER_ADMIN" | "STUDENT" = "ADMIN";
vi.mock("@/lib/auth/guards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/guards")>();
  return {
    ...actual,
    requireSuperAdmin: async () => {
      if (actorRole !== "SUPER_ADMIN") {
        const { ForbiddenError } = await import("@/lib/errors");
        throw new ForbiddenError();
      }
      return { id: actorId, role: actorRole, email: `${actorId}@rajalakshmi.edu.invalid`, collegeId: actorId };
    },
    requireActionRole: async (...roles: string[]) => {
      if (!roles.includes(actorRole)) {
        const { ForbiddenError } = await import("@/lib/errors");
        throw new ForbiddenError();
      }
      return { id: actorId, role: actorRole, email: `${actorId}@rajalakshmi.edu.invalid`, collegeId: actorId };
    },
  };
});

describe.skipIf(!ENABLED)("a second factor against recx_test", () => {
  const tag = `2fa-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let db: (typeof import("@/lib/db"))["db"];
  let totp: typeof import("@/lib/auth/totp");
  let secondFactor: typeof import("@/lib/auth/second-factor");
  let actions: typeof import("@/server/actions/second-factor");
  let shared: typeof import("@recx/shared");
  const userIds: string[] = [];

  /**
   * A serial, because `handle` is 30 characters and unique: `tag` plus a
   * descriptive suffix truncates to the same string for two tests, which is
   * a collision that looks like a product bug for an afternoon.
   */
  let serial = 0;

  async function account(
    suffix: string,
    role: "ADMIN" | "SUPER_ADMIN" | "STUDENT" | "TA_MENTOR" = "ADMIN",
  ): Promise<string> {
    const unique = `${tag}-${(serial += 1).toString(36)}`;
    const row = await db.user.create({
      data: {
        collegeId: unique.toUpperCase().slice(0, 32),
        email: `${unique}-${suffix}@rajalakshmi.edu.invalid`,
        firstName: "Two",
        lastName: suffix,
        handle: unique.slice(0, 30),
        role,
        status: "ACTIVE",
        passwordHash: null,
      },
      select: { id: true },
    });
    userIds.push(row.id);
    return row.id;
  }

  /** A confirmed credential with a known secret, as enrolment would leave it. */
  async function enrolled(userId: string): Promise<string> {
    const secret = totp.newSecret();
    await db.totpCredential.create({
      data: {
        userId,
        secretCipher: await totp.sealTotpSecret({ userId, secretBase32: secret }),
        confirmedAt: new Date(),
      },
    });
    return secret;
  }

  const codeNow = (secret: string) => totp.codeAt(secret, Math.floor(Date.now() / 1000 / 30))!;

  beforeAll(async () => {
    ({ db } = await import("@/lib/db"));
    totp = await import("@/lib/auth/totp");
    secondFactor = await import("@/lib/auth/second-factor");
    actions = await import("@/server/actions/second-factor");
    shared = await import("@recx/shared");
  }, 120_000);

  beforeEach(() => {
    cookieJar = new Map();
    actorRole = "ADMIN";
  });

  afterAll(async () => {
    if (!ENABLED || userIds.length === 0) return;
    await db.auditLog.deleteMany({ where: { targetUserId: { in: userIds } } });
    await db.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await db.secondFactorChallenge.deleteMany({ where: { userId: { in: userIds } } });
    await db.totpRecoveryCode.deleteMany({ where: { userId: { in: userIds } } });
    await db.totpCredential.deleteMany({ where: { userId: { in: userIds } } });
    await db.session.deleteMany({ where: { userId: { in: userIds } } });
    await db.platformSetting.deleteMany({ where: { key: shared.SECOND_FACTOR_SETTING_KEY } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
  }, 60_000);

  // ── The guards ────────────────────────────────────────────────────────

  it("refuses a credential for an account that may not hold one", async () => {
    for (const role of ["STUDENT", "TA_MENTOR"] as const) {
      const userId = await account(`role-${role.toLowerCase()}`, role);
      await expect(
        db.totpCredential.create({
          data: { userId, secretCipher: "x".repeat(64) },
        }),
        role,
      ).rejects.toThrow(/ADMIN and SUPER_ADMIN/);
    }
    // And accepts one for each role that may.
    for (const role of ["ADMIN", "SUPER_ADMIN"] as const) {
      const userId = await account(`ok-${role.toLowerCase()}`, role);
      await expect(
        db.totpCredential.create({ data: { userId, secretCipher: "x".repeat(64) } }),
      ).resolves.toMatchObject({ userId });
    }
  }, 60_000);

  it("refuses a time step that does not move forward — which is what makes one code one use", async () => {
    const userId = await account("rewind");
    await enrolled(userId);
    await db.totpCredential.update({ where: { userId }, data: { lastCounter: BigInt(1000) } });

    for (const counter of [1000, 999, 0]) {
      await expect(
        db.totpCredential.update({ where: { userId }, data: { lastCounter: BigInt(counter) } }),
        String(counter),
      ).rejects.toThrow(/move forward/);
    }
    // Forward is fine.
    await expect(
      db.totpCredential.update({ where: { userId }, data: { lastCounter: BigInt(1001) } }),
    ).resolves.toMatchObject({ lastCounter: BigInt(1001) });
    // And clearing it is not a way round the rule.
    await expect(
      db.totpCredential.update({ where: { userId }, data: { lastCounter: null } }),
    ).rejects.toThrow(/move forward/);
  }, 60_000);

  it("refuses un-confirming a credential, and moving one to another account", async () => {
    const userId = await account("immutable");
    const other = await account("immutable-other");
    await enrolled(userId);
    await expect(db.totpCredential.update({ where: { userId }, data: { confirmedAt: null } })).rejects.toThrow(
      /un-confirmed/,
    );
    await expect(db.totpCredential.update({ where: { userId }, data: { userId: other } })).rejects.toThrow(
      /another account/,
    );
  }, 60_000);

  it("refuses a counter on a credential nobody has confirmed", async () => {
    // The CHECK, not the trigger: a step recorded before the app was proved
    // is a code accepted before anybody checked the app works.
    const userId = await account("unconfirmed-counter");
    await db.totpCredential.create({ data: { userId, secretCipher: "x".repeat(64) } });
    await expect(
      db.totpCredential.update({ where: { userId }, data: { lastCounter: BigInt(5) } }),
    ).rejects.toThrow();
  }, 60_000);

  it("refuses un-spending a recovery code, or editing its hash or owner", async () => {
    const userId = await account("recovery-immutable");
    const other = await account("recovery-other");
    await enrolled(userId);
    const row = await db.totpRecoveryCode.create({
      // A distinct literal per test: `codeHash` is globally unique, so a
      // code reused across two tests collides on insert.
      data: { userId, codeHash: totp.hashRecoveryCode(`MZXW6YTBOIMZXW${randomBytes(1).toString("hex").toUpperCase().replace(/[0-9]/g, "A")}`) },
      select: { id: true },
    });
    const usedAt = new Date();
    await db.totpRecoveryCode.update({ where: { id: row.id }, data: { usedAt } });

    await expect(db.totpRecoveryCode.update({ where: { id: row.id }, data: { usedAt: null } })).rejects.toThrow(
      /un-spent/,
    );
    await expect(
      db.totpRecoveryCode.update({ where: { id: row.id }, data: { usedAt: new Date(Date.now() + 1000) } }),
    ).rejects.toThrow(/un-spent/);
    await expect(db.totpRecoveryCode.update({ where: { id: row.id }, data: { userId: other } })).rejects.toThrow(
      /immutable/,
    );
    await expect(
      db.totpRecoveryCode.update({
        where: { id: row.id },
        data: { codeHash: totp.hashRecoveryCode(totp.newRecoveryCodes().shown[0]!.replace(/-/g, "")) },
      }),
    ).rejects.toThrow(/immutable/);
  }, 60_000);

  it("refuses resetting a challenge's attempts or widening its window", async () => {
    const userId = await account("challenge-guard");
    const row = await db.secondFactorChallenge.create({
      data: {
        tokenHash: totp.hashChallengeToken(totp.newChallengeToken()),
        userId,
        attempts: 3,
        expiresAt: new Date(Date.now() + 60_000),
      },
      select: { id: true, expiresAt: true },
    });
    await expect(db.secondFactorChallenge.update({ where: { id: row.id }, data: { attempts: 2 } })).rejects.toThrow(
      /cannot fall/,
    );
    await expect(
      db.secondFactorChallenge.update({
        where: { id: row.id },
        data: { expiresAt: new Date(row.expiresAt.getTime() + 60_000) },
      }),
    ).rejects.toThrow(/cannot be widened/);
    // Six would pass the ceiling, which the CHECK refuses.
    await expect(db.secondFactorChallenge.update({ where: { id: row.id }, data: { attempts: 6 } })).rejects.toThrow();
    // Five is the ceiling and is allowed.
    await expect(
      db.secondFactorChallenge.update({ where: { id: row.id }, data: { attempts: 5 } }),
    ).resolves.toMatchObject({ attempts: 5 });
  }, 60_000);

  // ── Signing in ────────────────────────────────────────────────────────

  it("a correct password for an enrolled account creates NO session", async () => {
    const userId = await account("no-session");
    await enrolled(userId);

    expect(await secondFactor.secondFactorDemanded(userId)).toBe(true);
    await secondFactor.openChallenge(userId);

    // A challenge and a cookie, and nothing else. This is the design: with
    // no Session row, every page and every action refuses by construction.
    expect(await db.session.count({ where: { userId } })).toBe(0);
    expect(await db.secondFactorChallenge.count({ where: { userId } })).toBe(1);
    expect(cookieJar.has(secondFactor.SECOND_FACTOR_COOKIE)).toBe(true);
  }, 60_000);

  it("an unconfirmed credential is never asked for, so an abandoned setup locks nobody out", async () => {
    const userId = await account("unconfirmed");
    await db.totpCredential.create({ data: { userId, secretCipher: "x".repeat(64) } });
    expect(await secondFactor.secondFactorDemanded(userId)).toBe(false);
  }, 60_000);

  it("finishes the sign-in with a correct code, and only then is there a session", async () => {
    const userId = await account("completes");
    const secret = await enrolled(userId);
    actorId = userId;
    await secondFactor.openChallenge(userId);

    const result = await secondFactor.completeSecondFactor({ code: codeNow(secret) });
    expect(result).toMatchObject({ ok: true, home: "/admin", lastRecoveryCode: false });

    expect(await db.session.count({ where: { userId } })).toBe(1);
    expect(await db.secondFactorChallenge.count({ where: { userId } })).toBe(0);
    expect(cookieJar.has(secondFactor.SECOND_FACTOR_COOKIE)).toBe(false);

    const login = await db.auditLog.findMany({
      where: { actorId: userId, action: "auth.login" },
      select: { metadata: true },
    });
    expect(login).toHaveLength(1);
    expect(login[0]!.metadata).toMatchObject({ via: "totp", secondFactor: true });
    // The step was recorded, which is what spends the code.
    const credential = await db.totpCredential.findUniqueOrThrow({
      where: { userId },
      select: { lastCounter: true, lastUsedAt: true },
    });
    expect(credential.lastCounter).not.toBeNull();
    expect(credential.lastUsedAt).not.toBeNull();
  }, 60_000);

  it("refuses the same code a second time, in a fresh challenge", async () => {
    // The replay case. The first sign-in stored the step; the second
    // challenge offers the same code and must be refused even though the
    // code is still inside its 90-second window.
    const userId = await account("replay");
    const secret = await enrolled(userId);
    const code = codeNow(secret);

    await secondFactor.openChallenge(userId);
    expect(await secondFactor.completeSecondFactor({ code })).toMatchObject({ ok: true });

    cookieJar = new Map();
    await secondFactor.openChallenge(userId);
    const again = await secondFactor.completeSecondFactor({ code });
    expect(again).toMatchObject({ ok: false, failure: "code-reused" });
    // And no second session was minted.
    expect(await db.session.count({ where: { userId } })).toBe(1);
  }, 60_000);

  it("counts a wrong code against the challenge and dies at the ceiling", async () => {
    const userId = await account("attempts");
    await enrolled(userId);
    await secondFactor.openChallenge(userId);

    const max = shared.SECOND_FACTOR_MAX_ATTEMPTS;
    for (let attempt = 1; attempt < max; attempt += 1) {
      const result = await secondFactor.completeSecondFactor({ code: "000000" });
      expect(result, `attempt ${attempt}`).toMatchObject({ ok: false, attemptsLeft: max - attempt });
    }
    // The last one spends it and says so.
    expect(await secondFactor.completeSecondFactor({ code: "000000" })).toMatchObject({
      ok: false,
      failure: "too-many",
      attemptsLeft: 0,
    });
    // The challenge is gone and the cookie is spent, so the next try has
    // to start from the password again.
    expect(await db.secondFactorChallenge.count({ where: { userId } })).toBe(0);
    expect(await secondFactor.completeSecondFactor({ code: "000000" })).toMatchObject({ failure: "no-challenge" });
    expect(await db.session.count({ where: { userId } })).toBe(0);

    // Every refusal is audited against the account, by reason and never by code.
    const failures = await db.auditLog.findMany({
      where: { targetUserId: userId, action: "auth.second_factor_failed" },
      select: { metadata: true, actorId: true, sensitivity: true },
    });
    expect(failures).toHaveLength(max);
    for (const row of failures) {
      expect(row.actorId).toBeNull();
      expect(row.sensitivity).toBe("SECURITY");
      expect(JSON.stringify(row.metadata)).not.toContain("000000");
    }
  }, 60_000);

  it("refuses an expired challenge and clears it", async () => {
    const userId = await account("expired");
    await enrolled(userId);
    await secondFactor.openChallenge(userId);
    // Narrow the window rather than widen it, which the trigger allows.
    await db.secondFactorChallenge.updateMany({
      where: { userId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    expect(await secondFactor.pendingChallenge()).toBeNull();
    expect(await db.secondFactorChallenge.count({ where: { userId } })).toBe(0);
    expect(await db.session.count({ where: { userId } })).toBe(0);
  }, 60_000);

  it("refuses a challenge whose account stopped being allowed to sign in", async () => {
    const userId = await account("suspended-midway");
    await enrolled(userId);
    await secondFactor.openChallenge(userId);
    await db.user.update({ where: { id: userId }, data: { status: "DISABLED" } });

    expect(await secondFactor.pendingChallenge()).toBeNull();
    expect(await db.session.count({ where: { userId } })).toBe(0);
  }, 60_000);

  it("spends a recovery code once, and never twice", async () => {
    const userId = await account("recovery-spend");
    await enrolled(userId);
    actorId = userId;
    const { shown, hashes } = totp.newRecoveryCodes();
    await db.totpRecoveryCode.createMany({ data: hashes.map((codeHash) => ({ userId, codeHash })) });

    await secondFactor.openChallenge(userId);
    const result = await secondFactor.completeSecondFactor({ recoveryCode: shown[0] });
    expect(result).toMatchObject({ ok: true, lastRecoveryCode: false });

    const login = await db.auditLog.findFirst({
      where: { actorId: userId, action: "auth.login" },
      select: { metadata: true },
      orderBy: { createdAt: "desc" },
    });
    // By the fact of its use, never by value.
    expect(login!.metadata).toMatchObject({ via: "recovery" });
    expect(JSON.stringify(login!.metadata)).not.toContain(shown[0]!.replace(/-/g, ""));

    cookieJar = new Map();
    await secondFactor.openChallenge(userId);
    expect(await secondFactor.completeSecondFactor({ recoveryCode: shown[0] })).toMatchObject({
      ok: false,
      failure: "recovery-wrong",
    });
    expect(await db.totpRecoveryCode.count({ where: { userId, usedAt: null } })).toBe(hashes.length - 1);
  }, 60_000);

  it("says so when the last recovery code is spent", async () => {
    const userId = await account("recovery-last");
    await enrolled(userId);
    const code = totp.newRecoveryCodes().shown[0]!.replace(/-/g, "");
    await db.totpRecoveryCode.create({ data: { userId, codeHash: totp.hashRecoveryCode(code) } });

    await secondFactor.openChallenge(userId);
    expect(await secondFactor.completeSecondFactor({ recoveryCode: code })).toMatchObject({
      ok: true,
      lastRecoveryCode: true,
    });
  }, 60_000);

  it("refuses another account's recovery code", async () => {
    const mine = await account("recovery-mine");
    const theirs = await account("recovery-theirs");
    await enrolled(mine);
    await enrolled(theirs);
    const code = totp.newRecoveryCodes().shown[0]!.replace(/-/g, "");
    await db.totpRecoveryCode.create({ data: { userId: theirs, codeHash: totp.hashRecoveryCode(code) } });

    await secondFactor.openChallenge(mine);
    expect(await secondFactor.completeSecondFactor({ recoveryCode: code })).toMatchObject({
      ok: false,
      failure: "recovery-wrong",
    });
    // And it is still unspent, so the real owner can use it.
    expect(await db.totpRecoveryCode.count({ where: { userId: theirs, usedAt: null } })).toBe(1);
  }, 60_000);

  it("refuses a code when the secret cannot be read", async () => {
    const userId = await account("unreadable");
    await enrolled(userId);
    // A ciphertext from another account's row: the associated data binds it,
    // so this is what a copied column looks like.
    const other = await account("unreadable-other");
    const otherCipher = await totp.sealTotpSecret({ userId: other, secretBase32: totp.newSecret() });
    await db.totpCredential.update({ where: { userId }, data: { secretCipher: otherCipher } });

    await secondFactor.openChallenge(userId);
    expect(await secondFactor.completeSecondFactor({ code: "000000" })).toMatchObject({
      ok: false,
      failure: "code-unreadable",
    });
    expect(await db.session.count({ where: { userId } })).toBe(0);
  }, 60_000);

  // ── The policy ────────────────────────────────────────────────────────

  it("requires enrolment only of the two roles, only while the switch is on", async () => {
    const admin = await account("policy-admin");
    const student = await account("policy-student", "STUDENT");

    expect(await secondFactor.mustEnrolSecondFactor({ id: admin, role: "ADMIN" })).toBe(false);
    await db.platformSetting.upsert({
      where: { key: shared.SECOND_FACTOR_SETTING_KEY },
      create: { key: shared.SECOND_FACTOR_SETTING_KEY, value: "true" },
      update: { value: "true" },
    });
    expect(await secondFactor.mustEnrolSecondFactor({ id: admin, role: "ADMIN" })).toBe(true);
    expect(await secondFactor.mustEnrolSecondFactor({ id: student, role: "STUDENT" })).toBe(false);

    // Enrolling satisfies it; an UNCONFIRMED credential does not.
    await db.totpCredential.create({ data: { userId: admin, secretCipher: "x".repeat(64) } });
    expect(await secondFactor.mustEnrolSecondFactor({ id: admin, role: "ADMIN" })).toBe(true);
    await db.totpCredential.update({ where: { userId: admin }, data: { confirmedAt: new Date() } });
    expect(await secondFactor.mustEnrolSecondFactor({ id: admin, role: "ADMIN" })).toBe(false);
  }, 60_000);

  it("switching the policy off does not weaken an account that already enrolled", async () => {
    // The asymmetry that matters: the switch decides who is MADE to enrol.
    // Whether a confirmed credential is asked for is not a setting.
    const userId = await account("policy-off");
    await enrolled(userId);
    await db.platformSetting.upsert({
      where: { key: shared.SECOND_FACTOR_SETTING_KEY },
      create: { key: shared.SECOND_FACTOR_SETTING_KEY, value: "false" },
      update: { value: "false" },
    });
    expect(await secondFactor.secondFactorPolicy()).toBe(false);
    expect(await secondFactor.mustEnrolSecondFactor({ id: userId, role: "ADMIN" })).toBe(false);
    expect(await secondFactor.secondFactorDemanded(userId)).toBe(true);
  }, 60_000);

  // ── Enrolment ─────────────────────────────────────────────────────────

  it("enrols: a secret shown once, a code to prove it, then ten recovery codes", async () => {
    actorId = await account("enrol");
    actorRole = "ADMIN";

    const begun = await actions.beginSecondFactorEnrolment();
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    // Nothing about signing in has changed yet.
    expect(await secondFactor.secondFactorDemanded(actorId)).toBe(false);

    const secret = begun.data.secretForTyping.replace(/ /g, "");
    expect(begun.data.uri).toContain(secret);

    const form = new FormData();
    form.set("code", totp.codeAt(secret, Math.floor(Date.now() / 1000 / 30))!);
    const confirmed = await actions.confirmSecondFactor(null, form);
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.data.recoveryCodes).toHaveLength(shared.RECOVERY_CODE_COUNT);

    expect(await secondFactor.secondFactorDemanded(actorId)).toBe(true);
    expect(await db.totpRecoveryCode.count({ where: { userId: actorId, usedAt: null } })).toBe(
      shared.RECOVERY_CODE_COUNT,
    );
    // And the stored column is not the secret.
    const stored = await db.totpCredential.findUniqueOrThrow({
      where: { userId: actorId },
      select: { secretCipher: true },
    });
    expect(stored.secretCipher).not.toContain(secret);
    expect(await totp.openTotpSecret({ userId: actorId, sealed: stored.secretCipher })).toBe(secret);
  }, 60_000);

  it("refuses a wrong code at enrolment, and leaves the factor off", async () => {
    actorId = await account("enrol-wrong");
    const begun = await actions.beginSecondFactorEnrolment();
    expect(begun.ok).toBe(true);

    const form = new FormData();
    form.set("code", "000000");
    const confirmed = await actions.confirmSecondFactor(null, form);
    expect(confirmed.ok).toBe(false);
    expect(await secondFactor.secondFactorDemanded(actorId)).toBe(false);
    expect(await db.totpRecoveryCode.count({ where: { userId: actorId } })).toBe(0);
  }, 60_000);

  it("refuses a pending enrolment older than the fifteen minutes the page promises", async () => {
    /**
     * The page says "this setup expires in 15 minutes if you leave it", and
     * for a while nothing enforced it — which is the kind of sentence that
     * is worse than silence, because a reader acts on it. An unconfirmed
     * secret has been on a screen and may be in a screenshot, so it must
     * not stay usable while nobody finishes the setup.
     */
    actorId = await account("enrol-stale");
    const begun = await actions.beginSecondFactorEnrolment();
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;

    // Age the pending row past the window. `createdAt` is what the action
    // compares, and `beginSecondFactorEnrolment` resets it for that reason.
    await db.totpCredential.update({
      where: { userId: actorId },
      data: { createdAt: new Date(Date.now() - (shared.TOTP_ENROLMENT_MINUTES * 60_000 + 1_000)) },
    });

    const form = new FormData();
    form.set("code", totp.codeAt(begun.data.secretForTyping.replace(/ /g, ""), Math.floor(Date.now() / 1000 / 30))!);
    const confirmed = await actions.confirmSecondFactor(null, form);
    expect(confirmed.ok).toBe(false);
    if (!confirmed.ok) expect(confirmed.error).toBe(shared.TOTP_MESSAGES.enrolmentExpired);

    // And the stale row is gone, so the next attempt starts clean rather
    // than hitting the same refusal for ever.
    expect(await db.totpCredential.count({ where: { userId: actorId } })).toBe(0);
    expect(await secondFactor.secondFactorDemanded(actorId)).toBe(false);
  }, 60_000);

  it("accepts one that is inside the window", async () => {
    actorId = await account("enrol-fresh");
    const begun = await actions.beginSecondFactorEnrolment();
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    // A minute before the boundary: still good, so the check is a window
    // and not an accident that refuses everything.
    await db.totpCredential.update({
      where: { userId: actorId },
      data: { createdAt: new Date(Date.now() - (shared.TOTP_ENROLMENT_MINUTES - 1) * 60_000) },
    });
    const form = new FormData();
    form.set("code", totp.codeAt(begun.data.secretForTyping.replace(/ /g, ""), Math.floor(Date.now() / 1000 / 30))!);
    expect((await actions.confirmSecondFactor(null, form)).ok).toBe(true);
  }, 60_000);

  it("beginning again replaces the pending secret rather than adding one", async () => {
    actorId = await account("enrol-twice");
    const first = await actions.beginSecondFactorEnrolment();
    const second = await actions.beginSecondFactorEnrolment();
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.data.secretForTyping).not.toBe(first.data.secretForTyping);
    expect(await db.totpCredential.count({ where: { userId: actorId } })).toBe(1);

    // The FIRST secret no longer works, which is the point: two live
    // secrets of which only one is asked for is the state nobody can debug.
    const stale = new FormData();
    stale.set("code", totp.codeAt(first.data.secretForTyping.replace(/ /g, ""), Math.floor(Date.now() / 1000 / 30))!);
    expect((await actions.confirmSecondFactor(null, stale)).ok).toBe(false);
  }, 60_000);

  it("refuses to replace a CONFIRMED credential without removing it first", async () => {
    actorId = await account("enrol-confirmed");
    await enrolled(actorId);
    const begun = await actions.beginSecondFactorEnrolment();
    expect(begun.ok).toBe(false);
    if (!begun.ok) expect(begun.error).toBe(shared.TOTP_MESSAGES.alreadyEnrolled);
  }, 60_000);

  it("regenerates recovery codes, replacing every one of them", async () => {
    actorId = await account("regenerate");
    await enrolled(actorId);
    const first = totp.newRecoveryCodes();
    await db.totpRecoveryCode.createMany({ data: first.hashes.map((codeHash) => ({ userId: actorId, codeHash })) });
    // Spend one, so the replacement covers used codes too.
    await db.totpRecoveryCode.updateMany({ where: { codeHash: first.hashes[0] }, data: { usedAt: new Date() } });

    const fresh = await actions.regenerateRecoveryCodes();
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.data.recoveryCodes).toHaveLength(shared.RECOVERY_CODE_COUNT);

    const rows = await db.totpRecoveryCode.findMany({ where: { userId: actorId }, select: { codeHash: true, usedAt: true } });
    expect(rows).toHaveLength(shared.RECOVERY_CODE_COUNT);
    expect(rows.every((r) => r.usedAt === null)).toBe(true);
    for (const hash of first.hashes) expect(rows.map((r) => r.codeHash)).not.toContain(hash);
  }, 60_000);

  it("removes the factor only with a current code, and takes the recovery codes with it", async () => {
    actorId = await account("remove");
    const secret = await enrolled(actorId);
    await db.totpRecoveryCode.createMany({
      data: totp.newRecoveryCodes().hashes.map((codeHash) => ({ userId: actorId, codeHash })),
    });

    const wrong = new FormData();
    wrong.set("code", "000000");
    expect((await actions.removeSecondFactor(null, wrong)).ok).toBe(false);
    expect(await secondFactor.secondFactorDemanded(actorId)).toBe(true);

    const right = new FormData();
    right.set("code", codeNow(secret));
    expect((await actions.removeSecondFactor(null, right)).ok).toBe(true);
    expect(await secondFactor.secondFactorDemanded(actorId)).toBe(false);
    expect(await db.totpRecoveryCode.count({ where: { userId: actorId } })).toBe(0);
    expect(await db.totpCredential.count({ where: { userId: actorId } })).toBe(0);
  }, 60_000);

  it("refuses every enrolment action to a role that may not hold a factor", async () => {
    actorId = await account("enrol-student", "STUDENT");
    actorRole = "STUDENT";
    expect((await actions.beginSecondFactorEnrolment()).ok).toBe(false);
    expect((await actions.confirmSecondFactor(null, new FormData())).ok).toBe(false);
    expect((await actions.regenerateRecoveryCodes()).ok).toBe(false);
    expect((await actions.removeSecondFactor(null, new FormData())).ok).toBe(false);
    expect(await db.totpCredential.count({ where: { userId: actorId } })).toBe(0);
  }, 60_000);

  /**
   * The super-admin switch, and the one refusal `docs/RUNBOOK.md` §2.22
   * promises an operator: it will not turn on without an encryption key.
   *
   * Worth a test because of what the alternative looks like. With the
   * policy on and no key, every ADMIN and SUPER_ADMIN — the one who turned
   * it on included — is sent to a page that cannot mint a secret, and the
   * way back is a deploy.
   */
  it("refuses to require a second factor on a deployment with no encryption key", async () => {
    const settings = await import("@/server/actions/super-settings");
    actorId = await account("policy-switch", "SUPER_ADMIN");
    actorRole = "SUPER_ADMIN";

    const key = process.env.TOTP_ENCRYPTION_KEY;
    delete process.env.TOTP_ENCRYPTION_KEY;
    // `env()` caches, so the module has to be re-read for the change to be
    // visible — which is also why this case sits on its own.
    vi.resetModules();
    const { setSecondFactorPolicy } = await import("@/server/actions/super-settings");
    const refused = await setSecondFactorPolicy({ required: true });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toMatch(/TOTP_ENCRYPTION_KEY/);
    expect(await secondFactor.secondFactorPolicy()).toBe(false);

    process.env.TOTP_ENCRYPTION_KEY = key;
    vi.resetModules();

    // And with the key back, it turns on and is audited at SECURITY.
    const fresh = await import("@/server/actions/super-settings");
    const allowed = await fresh.setSecondFactorPolicy({ required: true });
    expect(allowed.ok).toBe(true);
    const rows = await db.auditLog.findMany({
      where: { actorId, action: "settings.second_factor_policy_changed" },
      select: { sensitivity: true, metadata: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sensitivity).toBe("SECURITY");
    expect(rows[0]!.metadata).toMatchObject({ required: true });

    // Put it back, so the cases after this one see the switch off.
    await fresh.setSecondFactorPolicy({ required: false });
    void settings;
  }, 60_000);

  it("audits every step at SECURITY, and never a secret or a code", async () => {
    actorId = await account("audit");
    const begun = await actions.beginSecondFactorEnrolment();
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    const secret = begun.data.secretForTyping.replace(/ /g, "");
    const form = new FormData();
    form.set("code", totp.codeAt(secret, Math.floor(Date.now() / 1000 / 30))!);
    const confirmed = await actions.confirmSecondFactor(null, form);
    expect(confirmed.ok).toBe(true);

    const rows = await db.auditLog.findMany({
      where: { targetUserId: actorId },
      orderBy: { createdAt: "asc" },
      select: { action: true, sensitivity: true, metadata: true },
    });
    expect(rows.map((r) => r.action)).toEqual(["auth.second_factor_started", "auth.second_factor_enabled"]);
    for (const row of rows) {
      expect(row.sensitivity).toBe("SECURITY");
      const text = JSON.stringify(row.metadata ?? {});
      expect(text).not.toContain(secret);
      if (confirmed.ok) for (const code of confirmed.data.recoveryCodes) expect(text).not.toContain(code);
    }
    // How many codes exist is recorded; which ones is not.
    expect(rows[1]!.metadata).toMatchObject({ recoveryCodes: shared.RECOVERY_CODE_COUNT });
  }, 60_000);
});
