import "server-only";
import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { z } from "zod";
import type { User } from "@recx/db";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { requestIpHash } from "@/lib/ip";
import { dummyPasswordHash, verifyPassword } from "@/lib/auth/password";
import { createSession, destroySession } from "@/lib/auth/session";
import { homeForRole } from "@/lib/auth/guards";
import type { SignInFailure } from "@/lib/auth/sign-in-errors";
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
  return { ok: true, home: homeForRole(account.role) };
}
