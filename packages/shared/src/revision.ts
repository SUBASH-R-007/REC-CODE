/**
 * Spaced revision (Phase 12c).
 *
 * SPEC §11's post-launch list calls this "the highest-value thing here that
 * LeetCode does not have, because the documented failure mode of sheet prep
 * is solving 300 problems once and retaining none." That sentence is the
 * whole design brief, and two things follow from it.
 *
 * **It is about retention, not volume.** A card exists for a problem the
 * student has already solved. Revising it pays 25 % of a first solve
 * (XP_RULES.revisionMultiplier) — enough to be worth the afternoon, far too
 * little to farm, and the daily caps apply as they do to everything else.
 *
 * **Three a day, and no more.** A queue that grows without a ceiling becomes
 * a debt the student stops opening — the failure mode of every flashcard app
 * anyone has abandoned. REVISION_DAILY_CAP is what is SURFACED, not what is
 * due: the backlog keeps its order and waits, and the page says how long it
 * is rather than hiding it.
 *
 * The intervals are SM-2's shape without SM-2's arithmetic. A quality score
 * a student grades themselves is the part of SM-2 that needs an honest
 * self-report; here the judge already knows whether they got it right, so
 * the only input is the verdict and the ladder is fixed. That is a smaller,
 * explainable thing — and a student who asks "why is this due today?" gets
 * an answer in one sentence.
 */

/** Days until the next review, by stage. A card past the last one is learned. */
export const REVISION_INTERVALS: readonly number[] = Object.freeze([1, 3, 7, 21, 60]);

/** The most cards a student is shown in one day. See the header. */
export const REVISION_DAILY_CAP = 3;

/** Stage 0 is "solved once, due tomorrow"; the last stage is the 60-day one. */
export const REVISION_LAST_STAGE = REVISION_INTERVALS.length - 1;

export interface RevisionSchedule {
  /** The stage the card now sits at. */
  readonly stage: number;
  /** Days from today until it is due again; null when it is learned. */
  readonly intervalDays: number | null;
  /** Past the last interval: the card is done and stops being surfaced. */
  readonly learned: boolean;
}

/** The schedule for a brand-new card: a problem just solved for the first time. */
export function firstSchedule(): RevisionSchedule {
  return { stage: 0, intervalDays: REVISION_INTERVALS[0]!, learned: false };
}

/**
 * A due card solved again: up one rung, and away for longer.
 *
 * Past the last rung the card is LEARNED and never comes back. A ladder with
 * no top is a subscription to your own past, and the point of the 60-day
 * interval is that clearing it means something.
 */
export function scheduleAfterReview(stage: number): RevisionSchedule {
  const next = Math.min(Math.max(stage, 0) + 1, REVISION_LAST_STAGE + 1);
  if (next > REVISION_LAST_STAGE) return { stage: REVISION_LAST_STAGE, intervalDays: null, learned: true };
  return { stage: next, intervalDays: REVISION_INTERVALS[next]!, learned: false };
}

/**
 * A due card attempted and not solved: down one rung, and due again today.
 *
 * Down one rather than back to zero, because forgetting the 21-day answer
 * does not mean you have forgotten the problem; and still due today rather
 * than tomorrow, because the student is looking at it right now and that is
 * the cheapest moment they will ever have to fix it.
 */
export function scheduleAfterLapse(stage: number): RevisionSchedule {
  const next = Math.max(0, Math.min(stage, REVISION_LAST_STAGE) - 1);
  return { stage: next, intervalDays: 0, learned: false };
}

/** "yyyy-mm-dd" `days` after `day`. Both are campus days. */
export function addDays(day: string, days: number): string {
  const at = new Date(`${day}T00:00:00.000Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

export interface RevisionCardLike {
  readonly problemId: string;
  readonly stage: number;
  /** Campus day, "yyyy-mm-dd". */
  readonly dueOn: string;
  readonly lapses: number;
  readonly learnedAt: Date | null;
}

/** Due means due today or overdue, and not already learned. */
export function isDue(card: RevisionCardLike, today: string): boolean {
  return card.learnedAt === null && card.dueOn <= today;
}

/**
 * The day's queue: the most overdue first, then the ones that have been
 * forgotten most often, then the oldest rung — and never more than
 * REVISION_DAILY_CAP of them.
 *
 * Overdue-first is the only ordering that keeps a backlog from rotting:
 * with anything else, the card a student keeps not doing is the card they
 * keep not seeing. `problemId` breaks the last tie so the order is stable
 * across reloads rather than whatever the database felt like returning.
 */
export function dueQueue(cards: readonly RevisionCardLike[], today: string, cap = REVISION_DAILY_CAP): RevisionCardLike[] {
  return cards
    .filter((card) => isDue(card, today))
    .sort(
      (a, b) =>
        a.dueOn.localeCompare(b.dueOn) ||
        b.lapses - a.lapses ||
        a.stage - b.stage ||
        a.problemId.localeCompare(b.problemId),
    )
    .slice(0, Math.max(0, cap));
}

/** How the page explains a card's own schedule, in one sentence. */
export function revisionReason(card: RevisionCardLike, today: string): string {
  const overdue = daysBetween(card.dueOn, today);
  const interval = REVISION_INTERVALS[Math.min(card.stage, REVISION_LAST_STAGE)]!;
  const forgotten = card.lapses === 0 ? "" : ` You have had to relearn it ${card.lapses === 1 ? "once" : `${card.lapses} times`}.`;
  if (overdue > 0) {
    return `Due ${overdue === 1 ? "yesterday" : `${overdue} days ago`}, on the ${interval}-day step.${forgotten}`;
  }
  return `Due today, on the ${interval}-day step.${forgotten}`;
}

/** Whole days from `from` to `to` ("yyyy-mm-dd"), negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** What the student is told when the queue is empty. */
export const REVISION_EMPTY = Object.freeze({
  nothingDue: "Nothing to revise today. Solve something new, and it will come back to you here tomorrow.",
  noCards: "Revision starts when you solve your first problem. Each one you solve comes back a day later, then three, then a week.",
});
