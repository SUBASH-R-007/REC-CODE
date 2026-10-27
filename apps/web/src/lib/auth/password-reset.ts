import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { SECURITY_EMAIL_KIND_PREFIX } from "@recx/shared";
import { audit } from "@/lib/audit";
import { findAccount, SIGN_IN_STATUSES } from "@/lib/auth/sign-in";
import { hashPassword, passwordIssues } from "@/lib/auth/password";
import { destroyAllSessions } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { activeSuperAdminIds, enqueueEmail } from "@/lib/outbox";
import { PRODUCT_NAME } from "@/lib/brand/names";

/**
 * Setting a password without ever having had one, and replacing one that
 * was forgotten. The same mechanism, because they are the same problem.
 *
 * Why this exists: a roster import creates students with `passwordHash`
 * NULL — the LMS is the identity source and no password crosses that
 * boundary (`lib/admin/roster.ts`) — so an imported student had no way to
 * obtain one, and the only accounts that could sign in were the seed's. A
 * one-time link is the standard answer and the only one that does not put
 * a password in a human's hands on the way.
 *
 * The rules it keeps, each of which is a decision rather than a default:
 *
 *   * **The token is never stored.** Only sha256(token), like a session
 *     token, a judge node token and a client address. A reader of this
 *     table cannot sign in as anybody.
 *   * **One hour, one use.** Spending a link is one conditional UPDATE
 *     whose row count is the proof; a trigger refuses un-spending it
 *     (migration 20261027190048).
 *   * **Asking tells the asker nothing.** The answer is identical whether
 *     the identifier matched an account, matched one that may not sign in,
 *     or matched nothing — so this is not a way to find out who studies
 *     here. The rate limit is on the identifier and the address, not on
 *     whether it existed.
 *   * **Setting a password ends every session.** If somebody else was
 *     signed in as this account, that is exactly the moment to remove them.
 *   * **A super-admin reset is announced.** Every active super-admin is
 *     mailed when a super-admin account's password is set this way: the one
 *     account whose mailbox is worth attacking for the platform's sake.
 */

/** A link is valid for one hour. Long enough to find the mail; short enough that a stolen one usually is not. */
export const RESET_TTL_MINUTES = 60;
/** 32 bytes of CSPRNG, base64url: 256 bits, no padding, URL-safe. */
const RESET_TOKEN_BYTES = 32;

export const RESET_EMAIL_KIND = `${SECURITY_EMAIL_KIND_PREFIX}password_reset`;
export const RESET_EMAIL_KIND_SUPER = `${SECURITY_EMAIL_KIND_PREFIX}password_reset_super_admin`;

export function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newResetToken(): { token: string; tokenHash: string } {
  const token = randomBytes(RESET_TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: hashResetToken(token) };
}

/** The link that goes in the mail. Absolute, because it is read outside the app. */
export function resetUrl(token: string, appUrl = env().APP_URL): string {
  return `${appUrl.replace(/\/+$/, "")}/reset-password?token=${encodeURIComponent(token)}`;
}

export function resetEmailBody(token: string, appUrl?: string): string {
  return [
    `Somebody asked to set the password of your ${PRODUCT_NAME} account.`,
    "",
    "Open this link to choose one. It works once, and only for the next hour:",
    resetUrl(token, appUrl),
    "",
    "If that was not you, nothing has happened yet and you can ignore this message —",
    "your current password still works. Tell your department coordinator if it keeps",
    "arriving.",
  ].join("\n");
}

/**
 * Ask for a link.
 *
 * Returns nothing a caller could use to tell the cases apart, on purpose:
 * the route answers the same page either way. A `false` here means no mail
 * was queued, not that the caller may say so.
 */
export async function requestPasswordReset(input: {
  identifier: string;
  ipHash: string | null;
}): Promise<{ queued: boolean }> {
  const identifier = input.identifier.trim().slice(0, 254);
  if (identifier.length === 0) return { queued: false };

  const account = await findAccount(identifier);
  if (!account || !SIGN_IN_STATUSES.has(account.status)) return { queued: false };

  const { token, tokenHash } = newResetToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + RESET_TTL_MINUTES * 60_000);

  await db.$transaction(async (tx) => {
    /**
     * Asking again supersedes the earlier links. Spending one is how a link
     * ends, so that is how a superseded one ends too: the alternative —
     * leaving several live at once — means a link mailed an hour ago still
     * works after the person has asked for a fresh one, which is the state
     * an attacker with old mailbox access wants.
     */
    await tx.passwordReset.updateMany({
      where: { userId: account.id, consumedAt: null },
      data: { consumedAt: now },
    });
    await tx.passwordReset.create({
      data: { userId: account.id, tokenHash, expiresAt, requestIpHash: input.ipHash },
    });
    await enqueueEmail(tx, {
      kind: RESET_EMAIL_KIND,
      toUserIds: [account.id],
      subject: `Set your ${PRODUCT_NAME} password`,
      bodyText: resetEmailBody(token),
      entityType: "User",
      entityId: account.id,
    });
  });

  await audit({
    actorId: null,
    action: "auth.password_reset_requested",
    entityType: "User",
    entityId: account.id,
    targetUserId: account.id,
    sensitivity: "SECURITY",
    ipHash: input.ipHash,
  });

  return { queued: true };
}

export type ResetFailure = "invalid" | "weak";
export type CompleteResetResult = { ok: true } | { ok: false; failure: ResetFailure };

/**
 * Spend a link and set the password.
 *
 * Every refusal that is about the link — missing, expired, already spent,
 * superseded, or for an account that may no longer sign in — comes back as
 * the same `invalid`, because the difference is only useful to somebody who
 * should not have the link.
 */
export async function completePasswordReset(input: {
  token: string;
  password: string;
  ipHash: string | null;
}): Promise<CompleteResetResult> {
  if (passwordIssues(input.password).length > 0) return { ok: false, failure: "weak" };

  const tokenHash = hashResetToken(input.token);
  const row = await db.passwordReset.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      userId: true,
      expiresAt: true,
      consumedAt: true,
      user: { select: { status: true, role: true } },
    },
  });
  const now = new Date();
  if (!row || row.consumedAt !== null || row.expiresAt <= now) return { ok: false, failure: "invalid" };
  if (!SIGN_IN_STATUSES.has(row.user.status)) return { ok: false, failure: "invalid" };

  const passwordHash = await hashPassword(input.password);
  const announce = row.user.role === "SUPER_ADMIN";

  const spent = await db.$transaction(async (tx) => {
    /**
     * The spend, and the whole race in one statement: two browsers opening
     * the same link both reach here, and exactly one of them updates a row.
     * The loser is told the link is not valid, which is true.
     */
    const consumed = await tx.passwordReset.updateMany({
      where: { id: row.id, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    if (consumed.count !== 1) return false;

    await tx.user.update({ where: { id: row.userId }, data: { passwordHash } });

    if (announce) {
      await enqueueEmail(tx, {
        kind: RESET_EMAIL_KIND_SUPER,
        toUserIds: await activeSuperAdminIds(tx),
        subject: `A super-admin password was set on ${PRODUCT_NAME}`,
        bodyText: [
          "A super-admin account's password was set through the forgot-password link.",
          "",
          "If that was not one of you, treat it as an incident: the audit log entry is",
          "auth.password_reset_completed, and /super/audit has it with the hashed",
          "address it came from.",
        ].join("\n"),
        entityType: "User",
        entityId: row.userId,
      });
    }
    return true;
  });

  if (!spent) return { ok: false, failure: "invalid" };

  /**
   * After the password is committed, not before: every session of this
   * account ends, including one an attacker was holding. Done outside the
   * transaction because it is a separate promise to keep — the password is
   * set either way — and because a failure here must not roll the new
   * password back.
   */
  await destroyAllSessions(row.userId);

  await audit({
    actorId: null,
    action: "auth.password_reset_completed",
    entityType: "User",
    entityId: row.userId,
    targetUserId: row.userId,
    sensitivity: "SECURITY",
    ipHash: input.ipHash,
  });

  return { ok: true };
}
