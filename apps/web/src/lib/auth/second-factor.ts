import "server-only";
import { cookies, headers } from "next/headers";
import {
  SECOND_FACTOR_CHALLENGE_MINUTES,
  SECOND_FACTOR_MAX_ATTEMPTS,
  SECOND_FACTOR_ROLES,
  SECOND_FACTOR_SETTING_KEY,
  secondFactorRequiredOf,
} from "@recx/shared";
import type { Role } from "@recx/db";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { requestIpHash } from "@/lib/ip";
import { isProduction } from "@/lib/env";
import { createSession, destroySession } from "@/lib/auth/session";
import { homeForRole, INITIAL_PASSWORD_PATH } from "@/lib/auth/guards";
import {
  hashChallengeToken,
  newChallengeToken,
  openTotpSecret,
  recoveryCodeLookup,
  secondFactorConfigured,
  verifyCode,
} from "@/lib/auth/totp";

/**
 * The half-finished sign-in: a password accepted, a code still owed
 * (Phase 16j).
 *
 * **There is no Session row until both factors pass.** That is the design
 * decision this file exists to hold. The alternative — a Session with a
 * `secondFactorAt IS NULL` column that every guard must remember to
 * check — makes a forgotten check into full administrative access, and this
 * product has a lot of guards. Here, a correct password with no code creates
 * a `SecondFactorChallenge` and nothing else, so there is no session for a
 * guard to mishandle: every page and every action refuses by construction,
 * because the viewer is signed out.
 *
 * The cookie holds the only copy of the token; the row holds sha256 of it,
 * an attempt count that cannot fall and an expiry that cannot widen (both
 * enforced by a trigger). Five minutes, five codes.
 */

export const SECOND_FACTOR_COOKIE = "recx_2fa";

function cookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isProduction(),
    // Scoped to the one route that spends it and the one page that offers
    // the form, so it is not sent with anything else.
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

/**
 * Is the super-admin's "require a second factor of admins" switch on?
 *
 * The setting and nothing else. It deliberately does NOT read the
 * environment: `requireUser` calls this on every admin page load through
 * `mustEnrolSecondFactor`, and making the base guard of the whole product
 * depend on `env()` parsing is a dependency that belongs nowhere near it.
 *
 * The encryption key is checked where it matters instead — the super-admin
 * switch refuses to turn on without one, `secondFactorDemanded` answers
 * false without one (a credential the server cannot read cannot be
 * checked), and the enrolment page says so in a sentence. The remaining
 * case, a key removed after the switch was turned on, sends an admin to
 * that page, which is the only place that can explain it.
 */
export async function secondFactorPolicy(): Promise<boolean> {
  const row = await db.platformSetting.findUnique({
    where: { key: SECOND_FACTOR_SETTING_KEY },
    select: { value: true },
  });
  return row?.value === "true";
}

/**
 * Must this account enrol before it can do anything?
 *
 * True only for a role in `SECOND_FACTOR_ROLES`, only while the policy is
 * on, and only when the account has no CONFIRMED credential. An
 * unconfirmed one does not count: an abandoned enrolment must not lock
 * somebody out, and it must not let them past either.
 */
export async function mustEnrolSecondFactor(user: { id: string; role: Role }): Promise<boolean> {
  // The role is checked FIRST, with no query behind it: `requireUser` calls
  // this on every authenticated page load, and a student must not pay for a
  // setting that cannot apply to them.
  if (!(SECOND_FACTOR_ROLES as readonly string[]).includes(user.role)) return false;
  if (!secondFactorRequiredOf(user.role, await secondFactorPolicy())) return false;
  const credential = await db.totpCredential.findUnique({
    where: { userId: user.id },
    select: { confirmedAt: true },
  });
  return credential?.confirmedAt == null;
}

/**
 * Does signing in to this account require a code?
 *
 * Note what this does NOT read: the policy switch. An account that HAS a
 * confirmed second factor is always asked for it. Turning the policy off
 * stops NEW admins being made to enrol; it does not quietly weaken the ones
 * who already did, which is what a single "is 2FA on" check would do.
 */
export async function secondFactorDemanded(userId: string): Promise<boolean> {
  if (!secondFactorConfigured()) return false;
  const credential = await db.totpCredential.findUnique({
    where: { userId },
    select: { confirmedAt: true },
  });
  return credential?.confirmedAt != null;
}

/** Start a challenge for an account whose password has just been accepted. */
export async function openChallenge(userId: string): Promise<void> {
  const [ipHash, headerStore, jar] = await Promise.all([requestIpHash(), headers(), cookies()]);
  const token = newChallengeToken();
  const expiresAt = new Date(Date.now() + SECOND_FACTOR_CHALLENGE_MINUTES * 60_000);

  // A browser part-way through another challenge is starting again: the old
  // row is spent rather than left to be retried.
  await db.secondFactorChallenge.deleteMany({ where: { userId } });
  await db.secondFactorChallenge.create({
    data: {
      tokenHash: hashChallengeToken(token),
      userId,
      userAgent: headerStore.get("user-agent")?.slice(0, 255) ?? null,
      ipHash,
      expiresAt,
    },
  });
  jar.set(SECOND_FACTOR_COOKIE, token, cookieOptions(SECOND_FACTOR_CHALLENGE_MINUTES * 60));
}

/** Forget whatever challenge this browser carried. */
export async function closeChallenge(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SECOND_FACTOR_COOKIE)?.value;
  if (token) await db.secondFactorChallenge.deleteMany({ where: { tokenHash: hashChallengeToken(token) } });
  jar.set(SECOND_FACTOR_COOKIE, "", cookieOptions(0));
}

export interface PendingChallenge {
  readonly id: string;
  readonly attempts: number;
  readonly user: { readonly id: string; readonly role: Role; readonly firstName: string; readonly mustChangePassword: boolean };
}

/**
 * The live challenge this browser carries, or null.
 *
 * Expired and exhausted rows answer null and are deleted on the way, so a
 * page reading this twice does not see a challenge it cannot use.
 */
export async function pendingChallenge(): Promise<PendingChallenge | null> {
  const token = (await cookies()).get(SECOND_FACTOR_COOKIE)?.value;
  if (!token) return null;
  const row = await db.secondFactorChallenge.findUnique({
    where: { tokenHash: hashChallengeToken(token) },
    select: {
      id: true,
      attempts: true,
      expiresAt: true,
      user: { select: { id: true, role: true, firstName: true, status: true, mustChangePassword: true } },
    },
  });
  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now() || row.attempts >= SECOND_FACTOR_MAX_ATTEMPTS) {
    await db.secondFactorChallenge.deleteMany({ where: { id: row.id } });
    return null;
  }
  /**
   * A status that changed between the password and the code: the account
   * may no longer sign in, and the challenge is worthless.
   *
   * A DYNAMIC import, because `sign-in.ts` imports this module (it opens
   * the challenge) and a static import both ways is a load-time cycle.
   * `SIGN_IN_STATUSES` is read rather than copied on purpose: one
   * definition of "may sign in", used by both doors, so they cannot drift.
   */
  const { SIGN_IN_STATUSES } = await import("@/lib/auth/sign-in");
  if (!SIGN_IN_STATUSES.has(row.user.status)) {
    await db.secondFactorChallenge.deleteMany({ where: { id: row.id } });
    return null;
  }
  return {
    id: row.id,
    attempts: row.attempts,
    user: {
      id: row.user.id,
      role: row.user.role,
      firstName: row.user.firstName,
      mustChangePassword: row.user.mustChangePassword,
    },
  };
}

export type SecondFactorFailure =
  | "no-challenge"
  | "code-format"
  | "code-wrong"
  | "code-reused"
  | "code-unreadable"
  | "recovery-wrong"
  | "too-many";

export type SecondFactorResult =
  | { ok: true; home: string; lastRecoveryCode: boolean }
  | { ok: false; failure: SecondFactorFailure; attemptsLeft: number };

/**
 * Finish a sign-in with a code from the authenticator app, or with a
 * recovery code.
 *
 * On success: the challenge is spent, the browser's old session dropped, a
 * new one minted, and `auth.login` audited with `via` saying which of the
 * two was used. On failure the attempt is counted — by the database, which
 * refuses a count that falls — and the sentence never says how close the
 * code was.
 */
export async function completeSecondFactor(input: {
  code?: unknown;
  recoveryCode?: unknown;
  nowSeconds?: number;
}): Promise<SecondFactorResult> {
  const challenge = await pendingChallenge();
  if (!challenge) {
    await closeChallenge();
    return { ok: false, failure: "no-challenge", attemptsLeft: 0 };
  }

  // Counted FIRST, so a request that dies half-way has still spent a try.
  const spent = await db.secondFactorChallenge.update({
    where: { id: challenge.id },
    data: { attempts: { increment: 1 } },
    select: { attempts: true },
  });
  const attemptsLeft = Math.max(0, SECOND_FACTOR_MAX_ATTEMPTS - spent.attempts);

  const ipHash = await requestIpHash();
  const refuse = async (failure: SecondFactorFailure): Promise<SecondFactorResult> => {
    await audit({
      actorId: null,
      action: "auth.second_factor_failed",
      entityType: "User",
      entityId: challenge.user.id,
      targetUserId: challenge.user.id,
      sensitivity: "SECURITY",
      // The reason, never the code. A reader learns that a wrong code was
      // offered, not what it was.
      metadata: { reason: failure },
      ipHash,
    });
    if (attemptsLeft === 0) await closeChallenge();
    return { ok: false, failure: attemptsLeft === 0 ? "too-many" : failure, attemptsLeft };
  };

  const typedRecovery = typeof input.recoveryCode === "string" && input.recoveryCode.trim().length > 0;
  let via: "totp" | "recovery";
  let lastRecoveryCode = false;

  if (typedRecovery) {
    const lookup = recoveryCodeLookup(input.recoveryCode);
    if (!lookup) return refuse("recovery-wrong");
    // Spend it with a conditional update: the row count settles a race
    // between two requests holding the same code, and the trigger refuses
    // un-spending one afterwards.
    const spentCode = await db.totpRecoveryCode.updateMany({
      where: { codeHash: lookup, userId: challenge.user.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (spentCode.count !== 1) return refuse("recovery-wrong");
    const left = await db.totpRecoveryCode.count({ where: { userId: challenge.user.id, usedAt: null } });
    lastRecoveryCode = left === 0;
    via = "recovery";
  } else {
    const credential = await db.totpCredential.findUnique({
      where: { userId: challenge.user.id },
      select: { secretCipher: true, confirmedAt: true, lastCounter: true },
    });
    if (!credential || credential.confirmedAt === null) return refuse("code-unreadable");

    const secret = await openTotpSecret({ userId: challenge.user.id, sealed: credential.secretCipher });
    if (!secret) return refuse("code-unreadable");

    const checked = verifyCode({
      secretBase32: secret,
      typed: input.code,
      nowSeconds: input.nowSeconds ?? Math.floor(Date.now() / 1000),
      lastCounter: credential.lastCounter === null ? null : Number(credential.lastCounter),
    });
    if (!checked.ok) {
      return refuse(
        checked.problem === "format"
          ? "code-format"
          : checked.problem === "reused"
            ? "code-reused"
            : checked.problem === "unreadable"
              ? "code-unreadable"
              : "code-wrong",
      );
    }

    // The step moves forward or the database refuses it, which is what
    // makes one code one use when two requests arrive together.
    try {
      await db.totpCredential.update({
        where: { userId: challenge.user.id },
        data: { lastCounter: BigInt(checked.counter), lastUsedAt: new Date() },
      });
    } catch {
      return refuse("code-reused");
    }
    via = "totp";
  }

  const headerStore = await headers();
  await db.secondFactorChallenge.deleteMany({ where: { id: challenge.id } });
  (await cookies()).set(SECOND_FACTOR_COOKIE, "", cookieOptions(0));

  await destroySession();
  await createSession(challenge.user.id, headerStore.get("user-agent"));
  await db.user.update({ where: { id: challenge.user.id }, data: { lastLoginAt: new Date() } });
  await audit({
    actorId: challenge.user.id,
    action: "auth.login",
    entityType: "User",
    entityId: challenge.user.id,
    // Which factor finished it. A recovery code is the one worth noticing
    // in a log, and it is recorded by the fact of its use, never by value.
    metadata: { via, secondFactor: true },
    ipHash,
  });

  return {
    ok: true,
    home: challenge.user.mustChangePassword ? INITIAL_PASSWORD_PATH : homeForRole(challenge.user.role),
    lastRecoveryCode,
  };
}
