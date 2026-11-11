/**
 * What a student, a mentor and an administrator are TOLD when the inactivity
 * policy acts (Phase 8d).
 *
 * In `@recx/shared` rather than beside the job, for two reasons. The copy
 * test that asserts no student-facing string contains the word "disabled"
 * can read it here without importing the scheduler; and the student page, the
 * notification and the email are three renderings of one message, which ought
 * to be one string rather than three that drift.
 *
 * The tone is the whole point of the phase. A student who stops submitting
 * has usually not stopped caring — they are ill, or sitting university exams,
 * or stuck and embarrassed. Every message here is written for that student
 * and not for the one who is gaming the system, because the first one is far
 * more common and the second one is not deterred by wording.
 *
 * Three rules every string obeys:
 *   1. never the word "disabled" to a student, at any rung;
 *   2. always say what to do next, in one action;
 *   3. never imply they have done something wrong.
 */

import { RESTRICTION_STAGE_LABEL, type RestrictionStage } from "./inactivity-policy";

export interface StageMessage {
  readonly title: string;
  readonly body: string;
  /** Where the one action lives. */
  readonly link: string;
}

/** The notification kind, so /notifications can group these. */
export const INACTIVITY_NOTIFICATION_KIND = "inactivity.stage";
export const INACTIVITY_NOTIFICATION_LINK = "/dashboard";

export function stageMessage(stage: RestrictionStage, countedDays: number): StageMessage {
  const days = `${countedDays} ${countedDays === 1 ? "day" : "days"}`;
  switch (stage) {
    case "NUDGED":
      return {
        title: "Still with us?",
        body: `It has been ${days} since you last practised. Nothing has changed about your account — this is just a nudge. One problem is enough to reset it, and if something is in the way, you can tell us about it.`,
        link: INACTIVITY_NOTIFICATION_LINK,
      };
    case "WARNED":
      return {
        title: "It has been a while",
        body: `${days} without practice. Your mentor has been told, because somebody who can help ought to know — not because you are in trouble. If you were ill or away, ask for those days to be excused and they will not count. Otherwise, one problem clears this.`,
        link: "/account/leave",
      };
    case "SOFT_RESTRICTED":
      return {
        title: "Your place on the leaderboard is paused",
        body: `After ${days} without practice you are off the public leaderboard and cannot enter a contest. Everything else works: you can sign in, read any problem, solve, and sit any assessment you are scheduled for. Solve one problem and this lifts straight away — nobody has to approve it.`,
        link: "/account/reactivate",
      };
    case "DISABLED":
      return {
        title: "Your account is paused",
        body: "Your account has been paused and the placement cell can reopen it. Write to them and they will — this is not a decision about you, and it is not final.",
        link: "/account/reactivate",
      };
    case "NONE":
      return {
        title: "You are back",
        body: "Your account is fully active again and you are back on the leaderboard. Nothing was lost while it was paused.",
        link: INACTIVITY_NOTIFICATION_LINK,
      };
  }
}

/**
 * What the mentor is told.
 *
 * The spec's reason for notifying a named human: non-progress must be visible
 * to somebody who can intervene. So this message is an ASK, not a report — a
 * mentor who reads "student X is at 7 days" does nothing, and a mentor who
 * reads "ask them whether something is wrong" sometimes does.
 *
 * It carries the college id and the day count and no more. A mentor does not
 * need to be told what the platform suspects.
 */
export function mentorMessage(input: {
  readonly collegeId: string;
  readonly name: string;
  readonly stage: RestrictionStage;
  readonly countedDays: number;
}): { subject: string; body: string } {
  return {
    subject: `${input.name} (${input.collegeId}) has not practised for ${input.countedDays} days`,
    body: [
      `${input.name} (${input.collegeId}) has gone ${input.countedDays} counted days without practice, so REC Code has moved them to "${RESTRICTION_STAGE_LABEL[input.stage]}".`,
      "",
      "Counted days already exclude holidays, exam weeks, placement weeks and any approved leave, so this is not somebody who was simply away.",
      "",
      "The useful thing is a conversation. People stop practising because they are ill, because they are behind and embarrassed, or because they are stuck on one problem and have not said so — and none of those is fixed by a notification. If they were away for a reason, they can ask for those days to be excused at /account/leave and the count drops.",
      "",
      "Nothing has been taken away from them that one solved problem will not restore.",
    ].join("\n"),
  };
}

export const MENTOR_EMAIL_KIND = "inactivity.mentor";

/** The audit action names, so the job and the audit reader agree. */
export const INACTIVITY_AUDIT_ACTIONS = {
  escalated: "inactivity.stage_escalated",
  cleared: "inactivity.stage_cleared",
  reviewRaised: "inactivity.admin_review_raised",
  selfCleared: "inactivity.self_cleared",
  staffCleared: "inactivity.staff_cleared",
  leaveReversed: "inactivity.leave_reversed",
} as const;
