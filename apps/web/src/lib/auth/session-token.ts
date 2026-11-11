import { createHash } from "node:crypto";
import type { Db } from "@recx/db";
import { RECX_SESSION_COOKIE } from "@recx/shared";

/**
 * Session lookup by raw cookie token, shared by session.ts (App Router) and
 * the Pages Router sign-in page (src/lib/pages-server.ts). Next refuses
 * next/headers and `server-only` anywhere in a pages/ import graph, so this
 * module has neither and takes the database client as an argument.
 */

/**
 * One name, declared in `packages/shared` (Phase 14g).
 *
 * REC Exam Browser sets this cookie itself from the value the launch
 * exchange hands it, so the name is now part of a protocol two
 * independently built halves speak. A rename that reached only one of them
 * would log every candidate out of their exam.
 */
export const SESSION_COOKIE = RECX_SESSION_COOKIE;

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
