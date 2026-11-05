import type { Db } from "./index";

/**
 * Ending a REC Exam Browser sitting (Phase 14h).
 *
 * Here rather than in `apps/web` because two processes end sittings. The web
 * app ends one the moment a candidate hands in, which is where it belongs —
 * a session that outlives the paper by even a minute is a signed-in window
 * on a machine the candidate owns. The scheduler ends the ones nobody handed
 * in, because `autoSubmitExpired` closes attempts at their deadline without
 * any request from the browser that was sitting them.
 *
 * It is plain Prisma, with no environment, no audit and no secret, which is
 * what makes it shareable. `docs/EXAM-BROWSER.md` §5 is what a sitting is.
 */

/**
 * Just the three delegates this needs. Narrowed from `Db` rather than from
 * `PrismaClient`: every client in this repository is wrapped with the
 * frozen-version guard (`createPrismaClient`), and an extended client's
 * delegates are not structurally the raw ones.
 */
type SittingDb = Pick<Db, "assessmentAttempt" | "examBrowserSitting" | "session">;

export interface EndSittingsReport {
  readonly sittingsEnded: number;
  readonly attemptsReleased: number;
  readonly sessionsRevoked: number;
}

const NOTHING: EndSittingsReport = Object.freeze({ sittingsEnded: 0, attemptsReleased: 0, sessionsRevoked: 0 });

/**
 * End these sittings: revoke the attestation, revoke the session, record when.
 *
 * The order is the design, and each step undoes a different thing:
 *
 *   1. **Clear the attempts' `examBrowserSittingId`.** This is what actually
 *      stops the sitting key working. The containment check compares the
 *      presented sitting against this column and never loads the sitting row
 *      — which is how a heartbeat every fifteen seconds stays one query
 *      lighter — so an unreferenced sitting is a revoked one.
 *   2. **Delete the sessions.** A window that can no longer attest must not
 *      still be signed in. Deleting nulls `ExamBrowserSitting.sessionId`
 *      through the foreign key, while `sessionIssuedAt` survives, so the row
 *      still answers whether there was a session without being able to say
 *      which.
 *   3. **Stamp `endedAt`.** Only the record of when. The row itself is never
 *      deleted: which browser sat which paper is part of the record of the
 *      sitting.
 *
 * Idempotent. `endedAt: null` in the last filter means a sitting ended twice
 * keeps the first time, which is the true one.
 */
export async function endExamBrowserSittings(
  db: SittingDb,
  sittingIds: readonly string[],
): Promise<EndSittingsReport> {
  const ids = [...new Set(sittingIds.filter((id) => id !== ""))];
  if (ids.length === 0) return NOTHING;

  const sittings = await db.examBrowserSitting.findMany({
    where: { id: { in: ids } },
    select: { id: true, sessionId: true },
  });
  if (sittings.length === 0) return NOTHING;

  const released = await db.assessmentAttempt.updateMany({
    where: { examBrowserSittingId: { in: ids } },
    data: { examBrowserSittingId: null },
  });

  const sessionIds = sittings.map((row) => row.sessionId).filter((id): id is string => id !== null);
  const revoked =
    sessionIds.length > 0 ? await db.session.deleteMany({ where: { id: { in: sessionIds } } }) : { count: 0 };

  const ended = await db.examBrowserSitting.updateMany({
    where: { id: { in: ids }, endedAt: null },
    data: { endedAt: new Date() },
  });

  return { sittingsEnded: ended.count, attemptsReleased: released.count, sessionsRevoked: revoked.count };
}

/**
 * The sittings these attempts are being sat in.
 *
 * For the caller that knows which attempts it just closed and not which
 * browsers were sitting them — the scheduler's deadline sweep, whose UPDATE
 * is raw SQL over `AssessmentAttempt` and has no reason to know this table
 * exists. Must be asked BEFORE `endExamBrowserSittings`, which is what
 * clears the column it reads.
 */
export async function examBrowserSittingsOfAttempts(
  db: SittingDb,
  attemptIds: readonly string[],
): Promise<string[]> {
  if (attemptIds.length === 0) return [];
  const rows = await db.assessmentAttempt.findMany({
    where: { id: { in: [...attemptIds] }, examBrowserSittingId: { not: null } },
    select: { examBrowserSittingId: true },
  });
  return [...new Set(rows.map((row) => row.examBrowserSittingId).filter((id): id is string => id !== null))];
}
