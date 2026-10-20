import { createHash } from "node:crypto";
import type { Db } from "@recx/db";

/**
 * Session lookup by raw cookie token, shared by session.ts (App Router) and
 * the Pages Router sign-in page (src/lib/pages-server.ts). Next refuses
 * next/headers and `server-only` anywhere in a pages/ import graph, so this
 * module has neither and takes the database client as an argument.
 */

export const SESSION_COOKIE = "recx_session";

/** Account states that may hold a session. SOFT_RESTRICTED can still sign in. */
const SIGN_IN_STATUSES = new Set(["ACTIVE", "SOFT_RESTRICTED"]);

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * The live session (with its user) a raw cookie token names, or null when
 * there is none, it has expired (the row is deleted) or the account may not
 * sign in. Read-only otherwise: renewal is getCurrentUser()'s job.
 */
export async function liveSession(db: Db, token: string) {
  const session = await db.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    include: { user: true },
  });
  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) {
    await db.session.deleteMany({ where: { id: session.id } });
    return null;
  }
  if (!SIGN_IN_STATUSES.has(session.user.status)) return null;
  return session;
}
