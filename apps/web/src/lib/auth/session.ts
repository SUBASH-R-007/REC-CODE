import "server-only";
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { cache } from "react";
import type { User } from "@recx/db";
import { db } from "@/lib/db";
import { isProduction } from "@/lib/env";
import { isFeatureEnabled } from "@/lib/flags";
import { requestIpHash } from "@/lib/ip";
import { closeImpersonation, closeImpersonationsOf } from "@/lib/auth/impersonation";
import { SESSION_COOKIE, hashSessionToken, liveSession } from "@/lib/auth/session-token";

export { SESSION_COOKIE, hashSessionToken };
const SESSION_DAYS = 14;
const RENEW_THRESHOLD_DAYS = 7;
/** lastSeenAt is refreshed at most this often (avoid a write per request). */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
/** Account states that may hold a session (same set as session-token.ts). */
const SIGN_IN_STATUSES = new Set(["ACTIVE", "SOFT_RESTRICTED"]);

function cookieOptions(expires: Date) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isProduction(),
    path: "/",
    expires,
  };
}

/** Create a DB-backed session. The cookie carries the raw token; the DB only its sha256. */
export async function createSession(userId: string, userAgent?: string | null) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await db.session.create({
    data: {
      tokenHash: hashSessionToken(token),
      userId,
      expiresAt,
      userAgent: userAgent?.slice(0, 255) ?? null,
      ipHash: await requestIpHash(),
    },
  });
  (await cookies()).set(SESSION_COOKIE, token, cookieOptions(expiresAt));
}

/**
 * Sign this browser out. A live impersonation on the session is closed first
 * (SIGNED_OUT, audited): the ImpersonationSession row outlives the Session
 * row it hangs off.
 */
export async function destroySession() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    const tokenHash = hashSessionToken(token);
    const session = await db.session.findUnique({
      where: { tokenHash },
      select: { userId: true, impersonationId: true },
    });
    if (session?.impersonationId) {
      await closeImpersonation({
        impersonationId: session.impersonationId,
        reason: "SIGNED_OUT",
        actorId: session.userId,
        ipHash: await requestIpHash(),
      });
    }
    await db.session.deleteMany({ where: { tokenHash } });
  }
  store.delete(SESSION_COOKIE);
}

/**
 * Force-logout every session of a user (e.g. mid-assessment by an admin, or
 * an account leaving ACTIVE). Impersonations the user started are revoked
 * first.
 */
export async function destroyAllSessions(userId: string) {
  await closeImpersonationsOf(userId, "REVOKED");
  await db.session.deleteMany({ where: { userId } });
}

/** A live "view as" on the current session (lib/auth/impersonation.ts). */
export interface ImpersonationContext {
  id: string;
  sessionId: string;
  reason: string;
  startedAt: Date;
  expiresAt: Date;
  impersonator: Pick<User, "id" | "firstName" | "lastName" | "role">;
}

/**
 * The signed-in user, or, while a SUPER_ADMIN views as someone, the TARGET
 * user with `impersonation` set. Every action guard refuses to mutate while
 * `impersonation` is set (lib/auth/guards.ts).
 */
export type CurrentUser = User & { readonly impersonation?: ImpersonationContext };

/** The live session row behind the cookie, renewed or touched as needed. Cached per request. */
const currentSession = cache(async () => {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const session = await liveSession(db, token);
  if (!session) return null;
  const now = Date.now();

  const needsRenew = session.expiresAt.getTime() - now < RENEW_THRESHOLD_DAYS * 86_400_000;
  const needsTouch = now - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS;
  if (needsRenew || needsTouch) {
    const expiresAt = needsRenew ? new Date(now + SESSION_DAYS * 86_400_000) : session.expiresAt;
    await db.session
      .update({ where: { id: session.id }, data: { lastSeenAt: new Date(now), expiresAt } })
      .catch(() => undefined);
    if (needsRenew) {
      try {
        store.set(SESSION_COOKIE, token, cookieOptions(expiresAt));
      } catch {
        // Read-only cookie context (server component render): the next
        // action or route handler slides the cookie.
      }
    }
  }
  return session;
});

/** The id of the current Session row, or null when signed out. */
export async function currentSessionId(): Promise<string | null> {
  return (await currentSession())?.id ?? null;
}

/**
 * Follow the session's impersonation pointer. Every check runs on every
 * request: inside the 15-minute box, the impersonator still an ACTIVE
 * SUPER_ADMIN, the impersonation flag on, the target still able to sign in
 * and not a SUPER_ADMIN. A failed check closes the impersonation (EXPIRED
 * or REVOKED, audited) and the super-admin sees their own account again.
 */
async function resolveImpersonation(
  session: { id: string; impersonationId: string | null },
  self: User,
): Promise<CurrentUser> {
  const impersonationId = session.impersonationId;
  if (!impersonationId) return self;
  const row = await db.impersonationSession.findUnique({ where: { id: impersonationId } });
  if (!row || row.endedAt !== null) {
    await db.session
      .updateMany({ where: { id: session.id, impersonationId }, data: { impersonationId: null } })
      .catch(() => undefined);
    return self;
  }
  let endReason: "EXPIRED" | "REVOKED" | null = null;
  let target: User | null = null;
  if (row.expiresAt.getTime() <= Date.now()) {
    endReason = "EXPIRED";
  } else if (row.impersonatorId !== self.id || self.role !== "SUPER_ADMIN" || self.status !== "ACTIVE") {
    endReason = "REVOKED";
  } else if (!(await isFeatureEnabled("impersonation"))) {
    endReason = "REVOKED";
  } else {
    target = await db.user.findUnique({ where: { id: row.targetUserId } });
    if (!target || target.role === "SUPER_ADMIN" || !SIGN_IN_STATUSES.has(target.status)) endReason = "REVOKED";
  }
  if (endReason !== null || target === null) {
    await closeImpersonation({ impersonationId, reason: endReason ?? "REVOKED", actorId: null });
    return self;
  }
  return {
    ...target,
    impersonation: {
      id: row.id,
      sessionId: session.id,
      reason: row.reason,
      startedAt: row.startedAt,
      expiresAt: row.expiresAt,
      impersonator: { id: self.id, firstName: self.firstName, lastName: self.lastName, role: self.role },
    },
  };
}

/** Resolve the current user from the session cookie. Cached per request. */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const session = await currentSession();
  if (!session) return null;
  return resolveImpersonation(session, session.user);
});
