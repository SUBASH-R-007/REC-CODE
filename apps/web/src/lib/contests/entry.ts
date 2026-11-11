import "server-only";

import { isWithinWindow } from "@recx/shared";
import type { Db, DbTx } from "@recx/db";
import { contestWindowFor } from "@/lib/contests/attempt";

/**
 * Does this student's next submission on this problem belong to a contest?
 * (Phase 12q, slice 3.)
 *
 * Everything from `ContestProblemAttempt` downwards was built in Phase 5 —
 * the attempt row, the score, the rank, the freeze, the rating — and none
 * of it ever ran, because nothing told a submission which contest it was
 * for. `submitSolution` wrote `origin: "PRACTICE"` for every submission in
 * the product, so `finalizeSubmission`'s CONTEST branch never fired and
 * `ContestStanding` stayed empty however many contests were published. The
 * arena meanwhile told the student, in so many words, that "submissions you
 * make while this contest is running count towards it". This module is what
 * makes that sentence true.
 *
 * **It is derived, never passed.** The alternative — a `?contest=` on the
 * workspace link — would be a claim the student types, and the server would
 * have to re-check every part of it anyway (registered? is this problem in
 * that contest? is the window open?). Deriving it from the rows means there
 * is nothing to forge and nothing to lose: the catalogue, a bookmark and
 * the arena's own button all reach the same workspace, and all three count
 * the same way. It also answers the question the arena's sentence raises —
 * what a practice submission made during a contest window is — with
 * "the same thing", which is the only answer a student can predict.
 *
 * **The version is the contest's, not the problem's.** A contest pins a
 * `ProblemVersion`, so a problem republished mid-contest must not change
 * what is being answered — the same rule, and the same reason, as the
 * assessment path (`lib/exam/submit.ts`).
 */

/** The contest a submission is about to belong to. */
export interface LiveContestEntry {
  readonly contestId: string;
  readonly contestSlug: string;
  readonly contestTitle: string;
  /** The contest's pinned version, which is what gets judged. */
  readonly problemVersionId: string;
  /** "A", "B", "C" … as the arena and the board show it. */
  readonly index: string;
  /** When this student's clock runs out (their own, for a virtual run). */
  readonly endsAt: Date;
  /** A VIRTUAL run is scored on its own clock and stays off the live board. */
  readonly virtual: boolean;
}

type Client = Db | DbTx;

/**
 * The live contest entry for `userId` on `problemId` at `now`, or null.
 *
 * A problem may sit in more than one contest, and a student may be
 * registered for both at once — unusual, but `ContestProblem` is unique
 * only per (contest, version), so nothing forbids it. The tie is broken by
 * the clock that runs out first, then by contest id: whichever rule is
 * chosen it has to be *deterministic*, because the alternative is a
 * submission that lands in a different contest depending on row order.
 * Soonest-to-end is the one a student would expect, since that is the
 * contest they are about to lose.
 */
export async function findLiveContestEntry(
  client: Client,
  args: { userId: string; problemId: string; now: Date },
): Promise<LiveContestEntry | null> {
  const { userId, problemId, now } = args;

  const pinned = await client.contestProblem.findMany({
    where: {
      problemVersion: { problemId },
      contest: { status: "PUBLISHED" },
    },
    select: {
      index: true,
      problemVersionId: true,
      contest: {
        select: { id: true, slug: true, title: true, startsAt: true, endsAt: true, freezeMinutes: true },
      },
    },
  });
  if (pinned.length === 0) return null;

  const registrations = await client.contestRegistration.findMany({
    where: { userId, contestId: { in: pinned.map((p) => p.contest.id) } },
    select: { contestId: true, kind: true, virtualStartsAt: true },
  });
  if (registrations.length === 0) return null;

  const candidates: LiveContestEntry[] = [];
  for (const row of pinned) {
    const mine = registrations.filter((r) => r.contestId === row.contest.id);
    // The same preference applyContestSubmission makes: a live run first,
    // a virtual replay otherwise.
    const live = mine.find((r) => r.kind === "RATED" || r.kind === "UNRATED");
    const entry = live ?? mine.find((r) => r.kind === "VIRTUAL");
    if (!entry) continue;
    const window = contestWindowFor(row.contest, entry.virtualStartsAt ?? null);
    if (!isWithinWindow(window, now)) continue;
    candidates.push({
      contestId: row.contest.id,
      contestSlug: row.contest.slug,
      contestTitle: row.contest.title,
      problemVersionId: row.problemVersionId,
      index: row.index,
      endsAt: window.endsAt,
      virtual: !live,
    });
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => a.endsAt.getTime() - b.endsAt.getTime() || a.contestId.localeCompare(b.contestId));
  return candidates[0] ?? null;
}
