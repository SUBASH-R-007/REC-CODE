import "server-only";
import {
  aiHelperAccess,
  discussionAccess,
  helpAccess,
  type AiAccess,
  type DiscussionAccess,
  type HelpAccess,
  type HelpContext,
} from "@recx/shared";
import { db } from "@/lib/db";

/**
 * THE help chokepoint. Every hint and editorial read or reveal — the panels,
 * the reveal actions, anything later phases add — asks getHelpState() and
 * obeys `access`. Nothing else decides who may see help; there are no
 * per-feature branches. The policy itself is helpAccess() in @recx/shared:
 * CONTEST and ASSESSMENT get nothing, unconditionally.
 *
 * The context is always decided on the server (today the practice workspace
 * is PRACTICE); it is never taken from client input.
 */

/**
 * The practice workspace's context — the only surface that serves help in
 * Phase 3. Contest (Phase 5) and assessment (Phase 6) workspaces pass their
 * own context, decided from the student's live attempt on the server, and
 * get nothing.
 */
export const WORKSPACE_HELP_CONTEXT: HelpContext = "PRACTICE";

export interface HelpState {
  problemId: string;
  /** The problem's live version: the only version whose help is served. */
  liveVersionId: string;
  context: HelpContext;
  /** Judged practice submissions (CE included, IE excluded). */
  attempts: number;
  failedAttempts: number;
  solved: boolean;
  /** The first solve followed a tier-3 hint, the editorial or the AI helper. */
  assisted: boolean;
  /** Active workspace seconds (ProblemActivity). */
  activeSeconds: number;
  editorialVisibleAt: Date | null;
  now: Date;
  access: HelpAccess;
}

/**
 * The student's help state for one problem, or null when the problem is
 * unknown or not published (there is nothing to help with, and an
 * unpublished problem's help must not leak).
 */
export async function getHelpState(
  userId: string,
  problemId: string,
  context: HelpContext,
  options: { now?: Date } = {},
): Promise<HelpState | null> {
  const key = { userId_problemId: { userId, problemId } };
  const [problem, status, activity] = await Promise.all([
    db.problem.findUnique({
      where: { id: problemId },
      select: { id: true, status: true, liveVersionId: true, editorialVisibleAt: true },
    }),
    db.userProblemStatus.findUnique({
      where: key,
      select: { status: true, attempts: true, failedAttempts: true, assisted: true },
    }),
    db.problemActivity.findUnique({ where: key, select: { activeSeconds: true } }),
  ]);
  if (!problem || problem.status !== "PUBLISHED" || !problem.liveVersionId) return null;

  const now = options.now ?? new Date();
  const attempts = status?.attempts ?? 0;
  const failedAttempts = status?.failedAttempts ?? 0;
  const solved = status?.status === "SOLVED";
  const assisted = status?.assisted ?? false;
  const activeSeconds = activity?.activeSeconds ?? 0;
  const editorialVisibleAt = problem.editorialVisibleAt ?? null;

  return {
    problemId: problem.id,
    liveVersionId: problem.liveVersionId,
    context,
    attempts,
    failedAttempts,
    solved,
    assisted,
    activeSeconds,
    editorialVisibleAt,
    now,
    access: helpAccess({ context, attempts, failedAttempts, activeSeconds, solved, editorialVisibleAt, now }),
  };
}

/** The chokepoint allows no help at all here (a contest or assessment). */
export function helpClosed(state: HelpState): boolean {
  return state.access.maxHintTier === 0 && !state.access.editorial;
}

/** May this hint tier be revealed / shown? (Reads the chokepoint's decision.) */
export function hintAllowed(state: HelpState, tier: number): boolean {
  return tier >= 1 && tier <= state.access.maxHintTier;
}

/** May the editorial be viewed / shown? (Reads the chokepoint's decision.) */
export function editorialAllowed(state: HelpState): boolean {
  return state.access.editorial;
}

/**
 * May this viewer read the discussion, and post in it? (Reads the
 * chokepoint's decision.)
 *
 * The policy is `discussionAccess()` in @recx/shared: practice only,
 * reading needs a solve of any kind and posting needs an unassisted one.
 * It lives here with the hints for the same reason they do — "what may this
 * student see on this problem" is one question, and answering it in two
 * places is how the two answers drift apart.
 */
export function discussionAllowed(state: HelpState, moderator: boolean): DiscussionAccess {
  return discussionAccess({
    context: state.context,
    solved: state.solved,
    assisted: state.assisted,
    moderator,
  });
}

/**
 * May the AI helper answer? (Reads the chokepoint's decision.)
 *
 * It takes the same HelpState as the hints — the same server-decided
 * `context`, the same attempt and active-time counts — so the assistant
 * cannot be reachable anywhere a hint is not. The two extra arguments are
 * the things the chokepoint cannot know: whether a super-admin has the
 * helper switched on, and how many questions this student has already used
 * today.
 */
export function aiAllowed(
  state: HelpState,
  config: { enabled: boolean; dailyPerStudent: number },
  askedToday: number,
): AiAccess {
  return aiHelperAccess({
    context: state.context,
    attempts: state.attempts,
    failedAttempts: state.failedAttempts,
    activeSeconds: state.activeSeconds,
    solved: state.solved,
    editorialVisibleAt: state.editorialVisibleAt,
    now: state.now,
    enabled: config.enabled,
    askedToday,
    dailyPerStudent: config.dailyPerStudent,
  });
}
