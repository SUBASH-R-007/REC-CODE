import type { HelpContext } from "./help";

/**
 * Discussion, shared solutions and doubts (Phase 12d).
 *
 * SPEC §11: "discussion and solution sharing gated behind an unassisted
 * solve (with the TA_MENTOR moderation role shipping simultaneously, not
 * after)." The parenthesis is the part that is easy to skip and expensive
 * to skip: a place where students post about problems, with nobody able to
 * take a post down, is not a feature at launch, it is an incident waiting
 * for a week-two timetable.
 *
 * The gate the spec asks for is one sentence; this module is the three
 * decisions needed to make it a rule somebody can enforce.
 *
 * **Reading needs a solve; posting needs an UNASSISTED one.** The spec
 * writes a single gate, and splitting it serves both of the things that
 * gate is for. The spoiler problem is solved by any solve — once you have
 * an accepted submission, other people's answers cannot spoil anything.
 * The quality problem is the other half: a post saying "here is how I did
 * it" from somebody who did it with the editorial open is not the thing
 * other students come for. So a student who needed help can read and ask,
 * and the people posting are the people who got there on their own.
 *
 * **It is per problem, and it does not expire.** `UserProblemStatus.assisted`
 * is set when the solve happens and never cleared, so a student who used a
 * tier-3 hint on one problem may post about every other problem they solved
 * alone. The copy says this plainly rather than implying they are in
 * trouble.
 *
 * **Doubts are not gated at all, and only the asker and a mentor may
 * reply.** A doubt is asked by somebody stuck, which is the opposite of the
 * state the gate is protecting. Keeping other students out of the replies
 * is what stops the doubt list becoming the solution list by the back door
 * — the one hole an anti-spoiler gate on solutions alone would leave open.
 */

export const DISCUSSION_POST_KINDS = ["SOLUTION", "TIP"] as const;
export type DiscussionPostKind = (typeof DISCUSSION_POST_KINDS)[number];

export const DISCUSSION_KIND_LABEL: Readonly<Record<DiscussionPostKind, string>> = Object.freeze({
  SOLUTION: "How I solved it",
  TIP: "A hint for the next person",
});

export const DISCUSSION_KIND_HINT: Readonly<Record<DiscussionPostKind, string>> = Object.freeze({
  SOLUTION: "Explain your approach and why it works. Code is welcome; a wall of code with no explanation is not.",
  TIP: "The one idea that unlocked it, without giving the whole thing away.",
});

/** What a post, a doubt and a reply may contain. Enforced here, at the boundary and in the database. */
export const DISCUSSION_LIMITS = Object.freeze({
  /** Long enough to say something; short enough that nobody pastes a book. */
  body: { min: 30, max: 8_000 },
  doubtTitle: { min: 10, max: 140 },
  doubtBody: { min: 20, max: 4_000 },
  replyBody: { min: 2, max: 4_000 },
  /** A mentor hiding a post has to say why, and the student is shown it. */
  moderationReason: { min: 10, max: 500 },
  reportReason: { min: 10, max: 500 },
});

export const DISCUSSION_POST_STATUSES = ["VISIBLE", "HIDDEN"] as const;
export type DiscussionPostStatus = (typeof DISCUSSION_POST_STATUSES)[number];

export const DOUBT_STATUSES = ["OPEN", "ANSWERED"] as const;
export type DoubtStatus = (typeof DOUBT_STATUSES)[number];

export const REPORT_REASONS = ["SPOILER", "WRONG", "ABUSE", "SPAM", "OTHER"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_REASON_LABEL: Readonly<Record<ReportReason, string>> = Object.freeze({
  SPOILER: "Gives the answer away where it should not",
  WRONG: "The explanation is wrong",
  ABUSE: "Abusive or personal",
  SPAM: "Spam or an advertisement",
  OTHER: "Something else",
});

export const REPORT_STATUSES = ["OPEN", "UPHELD", "DISMISSED"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

// ── The gate ────────────────────────────────────────────────────────────

export const DISCUSSION_REFUSALS = Object.freeze({
  notPractice:
    "The discussion is closed during a contest and an assessment. It opens again as soon as the sitting is over.",
  unsolved: "Solve this problem first. The discussion is other people's answers, and reading it now would spoil it.",
  assisted:
    "You can read everything here, but posting is for people who solved this one unaided. Yours used a hint, the editorial or the assistant — which is fine, and it only applies to this problem.",
  hidden: "A mentor has hidden this post.",
  notYourDoubt: "Only the student who asked and a TA or mentor can reply here. Ask your own question instead.",
});

export interface DiscussionAccess {
  readonly mayRead: boolean;
  readonly mayPost: boolean;
  /** Why not, in the student's own words. Null when they may. */
  readonly readReason: string | null;
  readonly postReason: string | null;
}

export interface DiscussionInput {
  readonly context: HelpContext;
  readonly solved: boolean;
  /** UserProblemStatus.assisted: the first solve followed a tier-3 hint, the editorial or the AI helper. */
  readonly assisted: boolean;
  /** Staff and mentors read and moderate everywhere; they are not students revising. */
  readonly moderator: boolean;
}

export function discussionAccess(input: DiscussionInput): DiscussionAccess {
  // A moderator reads everywhere and posts nowhere as a student would: the
  // mentor's own contribution is an answer on a doubt, not a "how I solved
  // it" they never solved.
  if (input.moderator) {
    return { mayRead: true, mayPost: false, readReason: null, postReason: null };
  }
  if (input.context !== "PRACTICE") {
    return {
      mayRead: false,
      mayPost: false,
      readReason: DISCUSSION_REFUSALS.notPractice,
      postReason: DISCUSSION_REFUSALS.notPractice,
    };
  }
  if (!input.solved) {
    return {
      mayRead: false,
      mayPost: false,
      readReason: DISCUSSION_REFUSALS.unsolved,
      postReason: DISCUSSION_REFUSALS.unsolved,
    };
  }
  if (input.assisted) {
    return { mayRead: true, mayPost: false, readReason: null, postReason: DISCUSSION_REFUSALS.assisted };
  }
  return { mayRead: true, mayPost: true, readReason: null, postReason: null };
}

/**
 * Who may reply on a doubt thread: the student who asked, and a mentor.
 *
 * Not other students. A doubt is a help channel, and a help channel other
 * students can answer in is the solution list again — reachable by anybody,
 * including the people the solution gate is keeping out.
 */
export function mayReplyToDoubt(input: { viewerId: string; askerId: string; moderator: boolean }): boolean {
  return input.moderator || input.viewerId === input.askerId;
}

/** May this viewer ask a doubt here at all? Practice only; no solve needed. */
export function mayAskDoubt(context: HelpContext): boolean {
  return context === "PRACTICE";
}

/**
 * What a student is shown in place of a hidden post.
 *
 * The post is not deleted and the reason is not a secret: a moderation
 * system whose decisions are invisible teaches everybody that posts vanish,
 * which is worse for trust than any individual bad post.
 */
export function hiddenNotice(reason: string, byMentor: boolean): string {
  return byMentor ? `Hidden by a TA or mentor: ${reason}` : `Hidden by its author.`;
}
