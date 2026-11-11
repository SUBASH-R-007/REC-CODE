
/**
 * What a candidate agrees to before a proctored assessment (Phase 16e).
 *
 * SPEC §6, in the DPDP paragraph: *"`ConsentRecord { userId, assessmentId,
 * policyVersion, policyHash, acceptedAt, ipHash }` per assessment, with the
 * named Data Protection Officer / grievance contact on screen."* It is in
 * the model inventory of §4 and in no phase of the plan, which is how it
 * came to be the unowned precondition `notifyParentEmail` was waiting on
 * (`docs/ROADMAP.md` §2.7). It is also the one piece of the proctoring
 * design with a law behind it rather than a preference.
 *
 * **The hash is the point.** A record saying "accepted version 1" proves
 * nothing a year later if version 1's text is whatever the file says today.
 * So the record stores a hash of the exact words shown, and the words live
 * here as data rather than as JSX — which also means the readiness page and
 * the record cannot drift, because there is one list and both read it.
 *
 * **It is per assessment, not per account.** A blanket "I accept proctoring"
 * at sign-up would be consent to a thing the student has not met yet, and
 * SPEC's own shape (`userId, assessmentId`) says per assessment. A candidate
 * sitting four papers accepts four times, and each record names the paper.
 *
 * **It is not a dark pattern and it is not a gate on reading.** The rules
 * are on the readiness page before the clock starts, visible without
 * accepting anything, and SPEC §7 forbids hiding them until after the start.
 * The acceptance is an explicit control, unticked, that cannot be bundled
 * into the Start button — the whole value of a consent record is that
 * somebody chose.
 */

export const PROCTORING_CONSENT_VERSION = 1;

/**
 * Exactly what the client records, in the candidate's words.
 *
 * It lived in `apps/web/src/components/exam/monitored-chip.tsx` until Phase
 * 16e. It moved here because the readiness page shows this list and the
 * consent record hashes it: two copies could differ, and a record whose
 * hash does not match what was on screen is evidence of nothing. The chip
 * re-exports it, so the exam surface still has one name for it.
 */
export const MONITORED_SIGNALS: readonly string[] = Object.freeze([
  "When this tab loses focus or leaves full screen, and for how long",
  "When you paste, and whether the text came from inside or outside this exam",
  "The size and a one-way fingerprint of pasted and copied text — never the text itself",
  "When text appears without being typed (for example, inserted by an extension)",
  "Typing pace statistics — counts and timings, never what you type",
  "Copies, cuts and right-clicks",
  "Window size changes, and whether a second screen is attached",
  "Periodic snapshots of your code, so your work can be recovered and your progress shown",
  "Whether this tab is connected, every ten seconds",
]);

/**
 * The words shown, in order, and hashed. Changing ANY of them is a new
 * version: a record whose hash no longer matches its version is the one
 * thing this table exists to make impossible.
 *
 * Written as what is and is not done, because "we may collect certain
 * technical information" is the sentence that makes a notice worthless.
 */
export const PROCTORING_CONSENT_POINTS: readonly string[] = Object.freeze([
  "While this assessment is open, the platform records when the exam window loses focus, when you leave fullscreen, when you paste text from outside it, and when the page is hidden.",
  "It records the browser and operating system you sat it on, and a one-way hash of your network address. The address itself is never stored.",
  "It does not use your camera, your microphone or your screen. It does not record what you type outside the answer boxes, read your clipboard contents, see other windows or tabs, or look at anything on this machine outside the exam.",
  "None of these signals decides your result. The most any of them does automatically is flag the sitting for a person to review and hold the result back from the public leaderboard. A human makes every decision, and you are told if one is made about you.",
  "Your answers and this record are kept on college-controlled infrastructure in India. Proctoring records are deleted 180 days after your result is released, or once any review about them is finished — whichever is later.",
  "You can ask for a copy of everything recorded about your sitting, and you can raise a complaint about it, using the contact shown below.",
]);

/** The sentence beside the checkbox. Deliberately short, and it names what is being agreed to. */
export const PROCTORING_CONSENT_LABEL =
  "I have read the points above and I agree to sit this assessment under them.";

/** What a candidate is told if they do not agree. There is no penalty, and saying so is the point. */
export const PROCTORING_CONSENT_DECLINE =
  "You do not have to agree. If you do not, do not start the assessment — speak to your department, and nothing is recorded about this paper.";

export const CONSENT_SETTING_KEY = "consent";

export const CONSENT_CONTACT_UNSET =
  "Your college has not named a contact here yet. Ask your department, or your invigilator, for the person who handles proctoring data.";

/**
 * The exact text that is hashed: the version, every signal, every point and
 * the label, one per line and in the order they are read on screen.
 *
 * Everything a candidate was shown is in here. Anything shown but not
 * hashed would be a promise the record cannot prove was made.
 */
export function consentPolicyText(version = PROCTORING_CONSENT_VERSION): string {
  return [`v${version}`, ...MONITORED_SIGNALS, ...PROCTORING_CONSENT_POINTS, PROCTORING_CONSENT_LABEL].join("\n");
}
