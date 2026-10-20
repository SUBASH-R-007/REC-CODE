/**
 * The mentor of record, as copy (Phase 9d).
 *
 * The badge is a constant and it ships NOW, two phases before the discussion
 * powers it belongs to. SPEC §4 names the badge as part of the ROLE, and a
 * role whose visible marker arrives two phases after the role is a role
 * students cannot recognise — a student who is told "ask your mentor" has to
 * be able to tell which of the people answering is one.
 *
 * "TA / mentor", with the slash, because the college calls them both and
 * neither word alone is recognised by everybody: a teaching assistant is a
 * student's peer and a mentor is assigned by the placement cell, and the
 * same person is often both.
 */

export const MENTOR_BADGE_LABEL = "TA / mentor";

/** What a mentor badge means, for the title attribute and the a11y name. */
export const MENTOR_BADGE_DESCRIPTION =
  "A teaching assistant or mentor. They can see how much of the preparation you have covered, so they can help you plan — never your code, your drafts or your notes.";

/**
 * What a mentor can and cannot see, in the student's own words.
 *
 * Rendered to the student, not to staff. A student who does not know what a
 * mentor can see will assume the worst, and the worst is the thing that stops
 * them asking for help.
 */
export const MENTOR_VISIBILITY = Object.freeze({
  canSee: Object.freeze([
    "How many problems you have solved, and how many without a hint",
    "Which of the fourteen topics you have practised least",
    "When you were last active",
    "Why the placement cell asked them to speak to you",
  ]),
  cannotSee: Object.freeze([
    "Your code, submitted or not",
    "Your private notes",
    "Anything about exam proctoring",
    "Your accommodations",
  ]),
});
