import "server-only";
import { isSubmitLanguage, type SubmitLanguageKey } from "@recx/shared";
import { db } from "@/lib/db";
import { clampClientTime, type DraftSave } from "@/lib/drafts/schema";
import { NotFoundError, RateLimitError } from "@/lib/errors";
import { hitRateLimit } from "@/lib/rate-limit";

/**
 * Server-side CodeDraft access. Drafts are keyed by the SESSION user — a
 * student can only ever read or write their own.
 *
 * Saves are newest-wins at the row: a save carrying an older edit time than
 * the stored one is a no-op ({saved:false}), so a late beacon from a stale
 * tab can never overwrite newer code. Drafts are not audited: like practice
 * submissions they are the student's own working state, not a sensitive
 * mutation, and the row is its own record.
 */

/** A student saves at most every 3 s per tab; this only stops a runaway script. */
export const DRAFT_SAVE_RATE_LIMIT = { limit: 60, windowMs: 60_000 } as const;

export interface ServerDraft {
  language: SubmitLanguageKey;
  source: string;
  /** Epoch ms of the edit that produced it (client clock, clamped on save). */
  updatedAt: number;
}

/** The viewer's server drafts for one problem, every language. */
export async function loadServerDrafts(userId: string, problemId: string): Promise<ServerDraft[]> {
  const rows = await db.codeDraft.findMany({
    where: { userId, problemId },
    select: { language: true, source: true, clientUpdatedAt: true },
  });
  return rows.flatMap((row) =>
    isSubmitLanguage(row.language)
      ? [{ language: row.language, source: row.source, updatedAt: row.clientUpdatedAt.getTime() }]
      : [],
  );
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

/**
 * Upsert one draft if it is not older than the stored one. Throws
 * NotFoundError for a problem that is not published, RateLimitError past
 * DRAFT_SAVE_RATE_LIMIT.
 */
export async function saveServerDraft(userId: string, input: DraftSave, now: Date = new Date()): Promise<{ saved: boolean }> {
  const limit = await hitRateLimit(`draft:${userId}`, DRAFT_SAVE_RATE_LIMIT);
  if (!limit.allowed) throw new RateLimitError("Your code is being saved too often. It is kept on this device meanwhile.");

  const problem = await db.problem.findFirst({
    where: { id: input.problemId, status: "PUBLISHED", liveVersionId: { not: null } },
    select: { id: true },
  });
  if (!problem) throw new NotFoundError("That problem is not available.");

  const clientUpdatedAt = new Date(clampClientTime(input.clientUpdatedAt, now.getTime()));
  const key = { userId, problemId: problem.id, language: input.language };
  const update = () =>
    db.codeDraft.updateMany({
      where: { ...key, clientUpdatedAt: { lte: clientUpdatedAt } },
      data: { source: input.source, clientUpdatedAt },
    });

  if ((await update()).count > 0) return { saved: true };
  // Nothing updated: either the stored draft is newer (a no-op), or there is none yet.
  const existing = await db.codeDraft.findUnique({ where: { userId_problemId_language: key }, select: { userId: true } });
  if (existing) return { saved: false };
  try {
    await db.codeDraft.create({ data: { ...key, source: input.source, clientUpdatedAt } });
    return { saved: true };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // The row exists: either it is newer (a no-op) or a concurrent first
    // save created it a moment ago — one more conditional update settles it.
    return { saved: (await update()).count > 0 };
  }
}
