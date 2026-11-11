import "server-only";
import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { z } from "zod";
import type { User } from "@recx/db";
import { SECOND_FACTOR_PATHS } from "@recx/shared";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { requestIpHash } from "@/lib/ip";
import { dummyPasswordHash, verifyPassword } from "@/lib/auth/password";
import { createSession, destroySession } from "@/lib/auth/session";
import { homeForRole, INITIAL_PASSWORD_PATH } from "@/lib/auth/guards";
import type { SignInFailure } from "@/lib/auth/sign-in-errors";
import { openChallenge, secondFactorDemanded } from "@/lib/auth/second-factor";
import {
  hitRateLimit,
  LOGIN_RATE_LIMITS,
  releaseRateLimit,
  resetRateLimit,
  type RateLimitHit,
} from "@/lib/rate-limit";

/**
 * Sign in with a roll number or college email and a password — the body of
 * POST /api/auth/login (the sign-in page is a plain HTML form with no
 * JavaScript; see src/pages/login.tsx). There is no public sign-up:
 * accounts come from the REC Learning roster (or the seed), and identity
 * lives there.
 *
 * Failures come back as codes (lib/auth/sign-in-errors.ts); unexpected
 * errors throw for the route handler to log with a reference.
 */

// Messages are failure codes; the sign-in page owns the words.
const loginSchema = z.object({
  identifier: z
    .string({ invalid_type_error: "identifier-missing" })
    .trim()
    .min(1, "identifier-missing")
    .max(254, "identifier-long"),
  password: z
    .string({ invalid_type_error: "password-missing" })
    .min(1, "password-missing")
    // Bounds the Argon2id input; no real password is this long.
    .max(1024, "password-long"),
});

/**
 * Account states that may sign in (mirrors the session check). Exported
 * because a password reset must answer the same question — a link is worth
 * nothing to an account that could not sign in with it — and there must be
 * exactly one answer in the codebase.
 */
export const SIGN_IN_STATUSES = new Set<User["status"]>(["ACTIVE", "SOFT_RESTRICTED"]);

export type SignInResult =
  | { ok: true; home: string }
  /**
   * Phase 16j. The password was right and the account owes a code. NO
   * session exists at this point and none will until the code verifies --
   * `lib/auth/second-factor.ts` has the reasoning. `home` is the page that
   * asks, so the caller treats this exactly like a success for redirect
   * purposes and like a failure for everything else.
   */
  | { ok: true; secondFactor: true; home: string }
  | { ok: false; failure: SignInFailure; retryMinutes?: number };

/**
 * Look the account up by email (contains "@") or roll number. Both columns
 * are unique; the candidate list covers the common case variants while
 * staying on the unique index.
 *
 * Exported for the password-reset request, which has to resolve exactly the
 * same identifiers this page accepts — if the two ever disagreed, somebody
 * could sign in with an identifier they could not reset, or the reverse.
 */
export async function findAccount(identifier: string): Promise<User | null> {
  const variants = [...new Set([identifier, identifier.toLowerCase(), identifier.toUpperCase()])];
  return identifier.includes("@")
    ? db.user.findFirst({ where: { email: { in: variants } } })
    : db.user.findFirst({ where: { collegeId: { in: variants } } });
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export async function signIn(input: { identifier: unknown; password: unknown }): Promise<SignInResult> {
  const parsed = loginSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, failure: (parsed.error.issues[0]?.message ?? "identifier-missing") as SignInFailure };
  }
  const { identifier, password } = parsed.data;

  const [account, ipHash, headerStore] = await Promise.all([findAccount(identifier), requestIpHash(), headers()]);

  // Budget per account (the user id when it exists, else the hashed
  // identifier — so a known and an unknown account behave identically)
  // and per hashed client IP. Checked before Argon2id to spare the CPU.
  const accountKey = `login:acct:${account?.id ?? sha256(identifier.toLowerCase())}`;
  const hits: RateLimitHit[] = [await hitRateLimit(accountKey, LOGIN_RATE_LIMITS.account)];
  if (ipHash) hits.push(await hitRateLimit(`login:ip:${ipHash}`, LOGIN_RATE_LIMITS.ip));
  const refused = hits.filter((h) => !h.allowed);
  if (refused.length > 0) {
    // The attempt never happened: un-count it from any bucket that
    // admitted it. (Refusals are not audited — they are unbounded under a
    // flood; the failures that led to them were.)
    await Promise.all(hits.filter((h) => h.allowed).map((h) => releaseRateLimit(h)));
    const retryAfterMs = Math.max(...refused.map((h) => h.retryAfterMs));
    return { ok: false, failure: "rate-limited", retryMinutes: Math.max(1, Math.ceil(retryAfterMs / 60_000)) };
  }

  // Always run a real Argon2id verification — against a decoy hash for
  // unknown or password-less (LMS-SSO-only) accounts — so response timing
  // does not reveal whether an account exists.
  const valid = await verifyPassword(password, account?.passwordHash ?? (await dummyPasswordHash()));
  if (!account || !account.passwordHash || !valid) {
    if (account) {
      await audit({
        actorId: null,
        action: "auth.login_failed",
        entityType: "User",
        entityId: account.id,
        targetUserId: account.id,
        sensitivity: "SECURITY",
        ipHash,
      });
    }
    return { ok: false, failure: "credentials" };
  }

  // The account state is disclosed only to a caller who proved they hold
  // the password (otherwise it would leak account existence).
  if (!SIGN_IN_STATUSES.has(account.status)) return { ok: false, failure: "inactive" };

  // Success spends no budget, and clears the account's recent failures so
  // a student who mistyped a few times is not left near the limit.
  await Promise.all([...hits.map((h) => releaseRateLimit(h)), resetRateLimit(accountKey)]);

  /**
   * Phase 16j. An account with a confirmed second factor gets NO session
   * here: a challenge row, a cookie, and the page that asks for a code.
   * The password alone has created nothing, so there is no half-signed-in
   * session for a guard to get wrong -- every page and action refuses
   * because the viewer is, correctly, signed out.
   *
   * This is checked before the rotation below on purpose: a browser that
   * offers a correct password and then abandons the second step keeps the
   * session it already had, which is the right outcome for a shared
   * machine and the wrong one to discover afterwards.
   */
  if (await secondFactorDemanded(account.id)) {
    await audit({
      actorId: account.id,
      action: "auth.second_factor_required",
      entityType: "User",
      entityId: account.id,
      targetUserId: account.id,
      sensitivity: "SECURITY",
      ipHash,
    });
    await openChallenge(account.id);
    return { ok: true, secondFactor: true, home: SECOND_FACTOR_PATHS.verify };
  }

  // Rotate: drop any session this browser already carried, then mint a new one.
  await destroySession();
  await createSession(account.id, headerStore.get("user-agent"));
  await db.user.update({ where: { id: account.id }, data: { lastLoginAt: new Date() } });
  await audit({
    actorId: account.id,
    action: "auth.login",
    entityType: "User",
    entityId: account.id,
    ipHash,
  });
  /**
   * An account still holding the initial password an admin set lands on the
   * page that replaces it, not on its home. The guards refuse everything
   * else anyway (Phase 11f); this is so the first thing the student sees is
   * the form, rather than a bounce.
   */
  return { ok: true, home: account.mustChangePassword ? INITIAL_PASSWORD_PATH : homeForRole(account.role) };
}

/**
 * Sign in a subject the LMS has already authenticated (Phase 16i).
 *
 * No password is involved and none is checked: the id_token has been
 * verified against the provider's own key before this is called, and the
 * only question left is which account it names.
 *
 * **The roster decides, and nothing here creates an account.** The subject
 * is matched to `User.lmsUserId`, which `/admin/students/import` is the
 * only writer of. A subject with no row is refused — the import reconciles
 * roll numbers, refuses duplicate keys and leaves conflicts to a
 * super-admin, and none of that can happen inside a sign-in.
 *
 * `mustChangePassword` is deliberately NOT consulted. It marks an account
 * still holding an initial password an admin set, and somebody arriving
 * through the LMS has just proved their identity to the system of record —
 * sending them to choose a local password would be asking for the
 * credential this exists to replace.
 */
export async function signInWithLmsSubject(subject: string): Promise<
  { ok: true; home: string } | { ok: false; failure: "not-enrolled" | "inactive" }
> {
  const [account, ipHash, headerStore] = await Promise.all([
    db.user.findUnique({
      where: { lmsUserId: subject },
      select: { id: true, role: true, status: true },
    }),
    requestIpHash(),
    headers(),
  ]);

  if (!account) {
    // Not audited against a user, because there is no user; the subject is
    // not recorded either, since it is an identifier from another system
    // for somebody this one does not know.
    return { ok: false, failure: "not-enrolled" };
  }
  if (!SIGN_IN_STATUSES.has(account.status)) {
    await audit({
      actorId: null,
      action: "auth.login_failed",
      entityType: "User",
      entityId: account.id,
      targetUserId: account.id,
      sensitivity: "SECURITY",
      metadata: { via: "lms" },
      ipHash,
    });
    return { ok: false, failure: "inactive" };
  }

  await destroySession();
  await createSession(account.id, headerStore.get("user-agent"));
  await db.user.update({ where: { id: account.id }, data: { lastLoginAt: new Date() } });
  await audit({
    actorId: account.id,
    action: "auth.login",
    entityType: "User",
    entityId: account.id,
    // Which door, so a reader of the log can tell an LMS sign-in from a
    // password one without inferring it from what is missing.
    metadata: { via: "lms" },
    ipHash,
  });
  return { ok: true, home: homeForRole(account.role) };
}
