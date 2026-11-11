import "server-only";

import {
  canFreeze,
  divisionOf,
  freezeStartsAt,
  isFrozen,
  isProvisional,
  minutesFromStart,
  RATING_SEED,
  virtualWindow,
  type ContestKind,
  type ContestWindow,
  type Division,
} from "@recx/shared";
import type { ContestStatus, ContestVisibility, ParticipationKind } from "@recx/db";
import { db } from "@/lib/db";

/**
 * Read helpers for the contest pages (Phase 5). Nothing here writes.
 *
 * The board is read through these so the freeze is applied in ONE place: a
 * frozen contest serves the pre-freeze picture to everyone except staff, and
 * a participant always sees their own row live (SPEC §5).
 */

export type ContestPhase = "upcoming" | "running" | "finished";

export interface ContestListRow {
  id: string;
  slug: string;
  title: string;
  kind: ContestKind;
  status: ContestStatus;
  startsAt: Date;
  endsAt: Date;
  durationMinutes: number;
  isRated: boolean;
  phase: ContestPhase;
  problemCount: number;
  registeredAs: ParticipationKind | null;
  participants: number;
}

function phaseOf(contest: { startsAt: Date; endsAt: Date }, now: Date): ContestPhase {
  if (now < contest.startsAt) return "upcoming";
  if (now < contest.endsAt) return "running";
  return "finished";
}

/** A contest a student may see: PUBLIC, or COHORT matching their cohort. */
function visibleToCohort(user: { batchYear: number | null; departmentCode: string | null }) {
  return {
    OR: [
      { visibility: "PUBLIC" as ContestVisibility },
      {
        visibility: "COHORT" as ContestVisibility,
        AND: [
          { OR: [{ audienceBatchYear: null }, { audienceBatchYear: user.batchYear }] },
          { OR: [{ audienceDepartmentCode: null }, { audienceDepartmentCode: user.departmentCode }] },
        ],
      },
    ],
  };
}

/** A draft is invisible to students; everything else in its lifecycle is not. */
const STUDENT_VISIBLE_STATUSES: ContestStatus[] = ["PUBLISHED", "RUNNING", "FINISHED", "RATED"];

export async function listContests(
  user: { id: string; batchYear: number | null; departmentCode: string | null },
  now = new Date(),
): Promise<ContestListRow[]> {
  const rows = await db.contest.findMany({
    where: { status: { in: STUDENT_VISIBLE_STATUSES }, ...visibleToCohort(user) },
    orderBy: [{ startsAt: "desc" }],
    select: {
      id: true,
      slug: true,
      title: true,
      kind: true,
      status: true,
      startsAt: true,
      endsAt: true,
      isRated: true,
      _count: { select: { problems: true, registrations: true } },
      registrations: { where: { userId: user.id }, select: { kind: true } },
    },
  });

  return rows.map((c) => ({
    id: c.id,
    slug: c.slug,
    title: c.title,
    kind: c.kind,
    status: c.status,
    startsAt: c.startsAt,
    endsAt: c.endsAt,
    durationMinutes: Math.round((c.endsAt.getTime() - c.startsAt.getTime()) / 60_000),
    isRated: c.isRated,
    phase: phaseOf(c, now),
    // A draft's problems are hidden, but a published contest's count is not
    // a secret — the landing page states it before the start.
    problemCount: c._count.problems,
    registeredAs: c.registrations[0]?.kind ?? null,
    participants: c._count.registrations,
  }));
}

export interface ContestDetail {
  id: string;
  slug: string;
  title: string;
  rules: string;
  kind: ContestKind;
  status: ContestStatus;
  startsAt: Date;
  endsAt: Date;
  freezeMinutes: number;
  isRated: boolean;
  ratedParticipants: number | null;
  phase: ContestPhase;
  window: ContestWindow;
  /** The student's own clock, when they are running it virtually. */
  virtualStartsAt: Date | null;
  registeredAs: ParticipationKind | null;
  freezesAt: Date | null;
  frozen: boolean;
  problems: Array<{
    id: string;
    index: string;
    points: number;
    slug: string;
    title: string;
    /** This student's own attempt, which is never hidden by the freeze. */
    own: { solved: boolean; wrongAttempts: number; points: number } | null;
  }>;
}

export async function getContest(
  slug: string,
  user: { id: string; batchYear: number | null; departmentCode: string | null },
  now = new Date(),
): Promise<ContestDetail | null> {
  const contest = await db.contest.findFirst({
    where: { slug, status: { in: STUDENT_VISIBLE_STATUSES }, ...visibleToCohort(user) },
    select: {
      id: true,
      slug: true,
      title: true,
      rules: true,
      kind: true,
      status: true,
      startsAt: true,
      endsAt: true,
      freezeMinutes: true,
      isRated: true,
      ratedParticipants: true,
      problems: {
        orderBy: { index: "asc" },
        select: {
          id: true,
          index: true,
          points: true,
          problemVersion: { select: { title: true, problem: { select: { slug: true } } } },
        },
      },
      registrations: { where: { userId: user.id }, select: { kind: true, virtualStartsAt: true } },
    },
  });
  if (!contest) return null;

  const entry = contest.registrations[0] ?? null;
  const live: ContestWindow = {
    startsAt: contest.startsAt,
    endsAt: contest.endsAt,
    freezeMinutes: contest.freezeMinutes,
  };
  const window = entry?.virtualStartsAt ? virtualWindow(live, entry.virtualStartsAt) : live;

  // Problems are only listed once the student's own clock has started: a
  // contest's problem set is not readable before it begins.
  const started = now >= window.startsAt;
  const own = started
    ? await db.contestProblemAttempt.findMany({
        where: { contestId: contest.id, userId: user.id },
        select: { contestProblemId: true, solvedAt: true, wrongAttempts: true, points: true },
      })
    : [];
  const ownByProblem = new Map(own.map((a) => [a.contestProblemId, a]));

  return {
    id: contest.id,
    slug: contest.slug,
    title: contest.title,
    rules: contest.rules,
    kind: contest.kind,
    status: contest.status,
    startsAt: contest.startsAt,
    endsAt: contest.endsAt,
    freezeMinutes: contest.freezeMinutes,
    isRated: contest.isRated,
    ratedParticipants: contest.ratedParticipants,
    phase: phaseOf(window, now),
    window,
    virtualStartsAt: entry?.virtualStartsAt ?? null,
    registeredAs: entry?.kind ?? null,
    freezesAt: freezeStartsAt(window),
    frozen: isFrozen(window, now),
    problems: started
      ? contest.problems.map((p) => {
          const attempt = ownByProblem.get(p.id);
          return {
            id: p.id,
            index: p.index,
            points: p.points,
            slug: p.problemVersion.problem.slug,
            title: p.problemVersion.title,
            own: attempt
              ? {
                  solved: attempt.solvedAt !== null,
                  wrongAttempts: attempt.wrongAttempts,
                  points: attempt.points,
                }
              : null,
          };
        })
      : [],
  };
}

export interface StandingRow {
  rank: number | null;
  userId: string;
  /** Rendered through publicName() ("Priya S."): a board never shows a full surname. */
  firstName: string;
  lastName: string;
  handle: string;
  score: number;
  penalty: number;
  solved: number;
  /** True for the viewer's own row, which the freeze never hides. */
  self: boolean;
}

export interface StandingsView {
  contestId: string;
  slug: string;
  title: string;
  kind: ContestKind;
  frozen: boolean;
  freezesAt: Date | null;
  canFreeze: boolean;
  standingsVersion: number;
  rows: StandingRow[];
  /** The viewer's own row, always live even during the freeze. */
  own: StandingRow | null;
}

/**
 * The board. VIRTUAL runs are excluded (SPEC §5: a virtual contest is
 * excluded from standings), so only live RATED and UNRATED entries appear.
 *
 * During the freeze a student sees the board as it was when it froze, with
 * their own row live. Staff always see it live — they need the real picture
 * to run the contest.
 */
export async function getStandings(
  slug: string,
  viewer: { id: string; role: string; batchYear: number | null; departmentCode: string | null },
  now = new Date(),
): Promise<StandingsView | null> {
  const contest = await db.contest.findFirst({
    where: { slug, status: { in: STUDENT_VISIBLE_STATUSES }, ...visibleToCohort(viewer) },
    select: {
      id: true,
      slug: true,
      title: true,
      kind: true,
      startsAt: true,
      endsAt: true,
      freezeMinutes: true,
      standingsVersion: true,
    },
  });
  if (!contest) return null;

  const window: ContestWindow = {
    startsAt: contest.startsAt,
    endsAt: contest.endsAt,
    freezeMinutes: contest.freezeMinutes,
  };
  const staff = viewer.role === "ADMIN" || viewer.role === "SUPER_ADMIN";
  const frozen = isFrozen(window, now) && !staff;

  const rows = await db.contestStanding.findMany({
    where: {
      contestId: contest.id,
      // Live entries only: a virtual run never joins the real board.
      user: {
        contestRegistrations: { some: { contestId: contest.id, kind: { in: ["RATED", "UNRATED"] } } },
      },
      ...(frozen ? { updatedAt: { lt: freezeStartsAt(window) ?? now } } : {}),
    },
    orderBy: [{ rank: "asc" }, { score: "desc" }, { penalty: "asc" }, { userId: "asc" }],
    select: {
      rank: true,
      userId: true,
      score: true,
      penalty: true,
      solved: true,
      user: { select: { firstName: true, lastName: true, handle: true } },
    },
  });

  const map = (r: (typeof rows)[number]): StandingRow => ({
    rank: r.rank,
    userId: r.userId,
    firstName: r.user.firstName,
    lastName: r.user.lastName,
    handle: r.user.handle,
    score: r.score,
    penalty: r.penalty,
    solved: r.solved,
    self: r.userId === viewer.id,
  });

  const ownInBoard = rows.find((r) => r.userId === viewer.id);
  let own: StandingRow | null = ownInBoard ? map(ownInBoard) : null;
  if (own === null) {
    // Their own row during a freeze, or after it was updated inside it.
    const mine = await db.contestStanding.findUnique({
      where: { contestId_userId: { contestId: contest.id, userId: viewer.id } },
      select: {
        rank: true,
        userId: true,
        score: true,
        penalty: true,
        solved: true,
        user: { select: { firstName: true, lastName: true, handle: true } },
      },
    });
    own = mine ? map(mine) : null;
  }

  return {
    contestId: contest.id,
    slug: contest.slug,
    title: contest.title,
    kind: contest.kind,
    frozen,
    freezesAt: freezeStartsAt(window),
    canFreeze: canFreeze(window),
    standingsVersion: contest.standingsVersion,
    rows: rows.map(map),
    own,
  };
}

export interface RatingSummary {
  rating: number;
  contestsRated: number;
  provisional: boolean;
  division: Division;
  history: Array<{ contestSlug: string; contestTitle: string; before: number; after: number; delta: number; rank: number; at: Date }>;
}

/** A student's rating and its history, for /profile and the analysis page. */
export async function getRatingSummary(userId: string): Promise<RatingSummary> {
  const [current, history] = await Promise.all([
    db.userRating.findUnique({ where: { userId }, select: { rating: true, contestsRated: true } }),
    db.ratingChange.findMany({
      where: { userId },
      orderBy: { computedAt: "desc" },
      take: 50,
      select: {
        before: true,
        after: true,
        delta: true,
        rank: true,
        computedAt: true,
        contest: { select: { slug: true, title: true } },
      },
    }),
  ]);
  const rating = current?.rating ?? RATING_SEED;
  const contestsRated = current?.contestsRated ?? 0;
  return {
    rating,
    contestsRated,
    provisional: isProvisional(contestsRated),
    division: divisionOf(rating),
    history: history.map((h) => ({
      contestSlug: h.contest.slug,
      contestTitle: h.contest.title,
      before: h.before,
      after: h.after,
      delta: h.delta,
      rank: h.rank,
      at: h.computedAt,
    })),
  };
}

/** Elapsed minutes of a student's run, for the arena clock. */
export function elapsedMinutes(window: ContestWindow, now: Date): number {
  return minutesFromStart(window, now);
}
