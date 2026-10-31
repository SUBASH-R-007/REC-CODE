import "server-only";
import {
  REVISION_DAILY_CAP,
  campusDay,
  dueQueue,
  revisionReason,
  type RevisionCardLike,
} from "@recx/shared";
import { db } from "@/lib/db";

/**
 * The student's revision queue (Phase 12c).
 *
 * The cap is applied to what is SHOWN, not to what is counted: `backlog` is
 * the honest number of cards past their date, and the page says it. A queue
 * that silently hid its own length would be the flashcard app nobody opens
 * twice.
 *
 * A card for a problem that is no longer PUBLISHED is left out — a retired
 * problem is not something to send a student back to — but it is not
 * deleted, because the problem may come back and the student's history of
 * it is theirs.
 */

export interface RevisionItem {
  problemId: string;
  slug: string;
  displayCode: string;
  title: string;
  difficulty: "EASY" | "MEDIUM" | "HARD";
  stage: number;
  /** Campus day, "yyyy-mm-dd". */
  dueOn: string;
  lapses: number;
  reviews: number;
  /** One sentence saying why this is in front of them today. */
  reason: string;
  /** Days past its date; 0 when due today. */
  overdueDays: number;
}

export interface RevisionQueue {
  today: string;
  /** At most REVISION_DAILY_CAP, most overdue first. */
  items: RevisionItem[];
  /** Every card that is due, including the ones not shown. */
  backlog: number;
  /** Cards waiting for a future date. */
  scheduled: number;
  /** Cards that cleared the last rung and will not come back. */
  learned: number;
  /** When the next card falls due, or null when nothing is waiting. */
  nextDueOn: string | null;
}

export async function loadRevisionQueue(userId: string, now: Date = new Date()): Promise<RevisionQueue> {
  const today = campusDay(now);
  const [cards, learned] = await Promise.all([
    db.revisionCard.findMany({
      where: { userId, learnedAt: null, problem: { status: "PUBLISHED" } },
      select: {
        problemId: true,
        stage: true,
        dueOn: true,
        lapses: true,
        reviews: true,
        learnedAt: true,
        problem: { select: { slug: true, displayCode: true, title: true, difficulty: true } },
      },
      orderBy: { dueOn: "asc" },
    }),
    db.revisionCard.count({ where: { userId, learnedAt: { not: null } } }),
  ]);

  const like: (RevisionCardLike & { row: (typeof cards)[number] })[] = cards.map((row) => ({
    problemId: row.problemId,
    stage: row.stage,
    dueOn: row.dueOn.toISOString().slice(0, 10),
    lapses: row.lapses,
    learnedAt: row.learnedAt,
    row,
  }));

  const due = like.filter((card) => card.dueOn <= today);
  const shown = dueQueue(like, today, REVISION_DAILY_CAP);
  const waiting = like.filter((card) => card.dueOn > today).map((card) => card.dueOn);

  const items = shown.map((card): RevisionItem => {
    const row = (card as (typeof like)[number]).row;
    return {
      problemId: card.problemId,
      slug: row.problem.slug,
      displayCode: row.problem.displayCode,
      title: row.problem.title,
      difficulty: row.problem.difficulty,
      stage: card.stage,
      dueOn: card.dueOn,
      lapses: card.lapses,
      reviews: row.reviews,
      reason: revisionReason(card, today),
      overdueDays: Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${card.dueOn}T00:00:00Z`)) / 86_400_000)),
    };
  });

  return {
    today,
    items,
    backlog: due.length,
    scheduled: waiting.length,
    learned,
    nextDueOn: waiting.length > 0 ? waiting.reduce((a, b) => (a < b ? a : b)) : null,
  };
}

/** Just the number, for the dashboard and the nav badge. */
export async function countDueRevisions(userId: string, now: Date = new Date()): Promise<number> {
  return db.revisionCard.count({
    where: {
      userId,
      learnedAt: null,
      problem: { status: "PUBLISHED" },
      dueOn: { lte: new Date(`${campusDay(now)}T00:00:00.000Z`) },
    },
  });
}
