import { TOPICS, type Topic } from "./topics";

/**
 * The interview-experience archive (Phase 12e).
 *
 * SPEC §11 calls this "the moderated InterviewExperience archive —
 * structured fields, not prose — which is the only legal and genuinely
 * REC-specific source of company tags and 'asked at' frequency, and is
 * therefore load-bearing rather than a nicety."
 *
 * Four decisions follow from that sentence, and each is the reason a field
 * is missing rather than present.
 *
 * **No prose. None.** Not "short prose", not "a moderated note" — no free
 * text at all except the one place a student types a company name nobody
 * has entered yet. Two reasons, and the first is the one that matters: an
 * account of an interview written in a hurry names interviewers, repeats
 * questions under an NDA, and says things about a company that the college
 * would have to answer for. The second is that prose cannot be counted,
 * and counting is the whole point — "asked at" frequency is what makes
 * this load-bearing rather than a scrapbook.
 *
 * **Attributed in the database, anonymous on the page.** A rejection with
 * a name on it is a thing students will not post, and an archive nobody
 * posts to is worth nothing. Moderators see the author, because a report
 * with nobody behind it cannot be followed up.
 *
 * **Approved before it counts.** A submission changes no company tag until
 * a moderator has read it. The tags are a public claim about a company;
 * the cost of a wrong one is borne by somebody else.
 *
 * **Frequency is maintained, never computed on read** (SPEC §4(d)), in the
 * same transaction as the approval.
 */

export const INTERVIEW_ROUND_KINDS = [
  "ONLINE_ASSESSMENT",
  "TECHNICAL",
  "SYSTEM_DESIGN",
  "MANAGERIAL",
  "HR",
] as const;
export type InterviewRoundKind = (typeof INTERVIEW_ROUND_KINDS)[number];

export const INTERVIEW_ROUND_LABEL: Readonly<Record<InterviewRoundKind, string>> = Object.freeze({
  ONLINE_ASSESSMENT: "Online assessment",
  TECHNICAL: "Technical round",
  SYSTEM_DESIGN: "System design",
  MANAGERIAL: "Managerial",
  HR: "HR",
});

export const INTERVIEW_MODES = ["ON_CAMPUS", "OFF_CAMPUS", "REFERRAL"] as const;
export type InterviewMode = (typeof INTERVIEW_MODES)[number];

export const INTERVIEW_MODE_LABEL: Readonly<Record<InterviewMode, string>> = Object.freeze({
  ON_CAMPUS: "On-campus drive",
  OFF_CAMPUS: "Applied myself",
  REFERRAL: "Referral",
});

export const INTERVIEW_OUTCOMES = ["OFFER", "NO_OFFER", "WITHDREW", "WAITING"] as const;
export type InterviewOutcome = (typeof INTERVIEW_OUTCOMES)[number];

export const INTERVIEW_OUTCOME_LABEL: Readonly<Record<InterviewOutcome, string>> = Object.freeze({
  OFFER: "Offer",
  NO_OFFER: "No offer",
  WITHDREW: "I withdrew",
  WAITING: "Still waiting",
});

/**
 * What helped, from a closed list.
 *
 * This is the field a free-text "tips" box would have been, and the reason
 * it is a list: "revise graphs" is useful to the next student, and the
 * paragraph somebody would actually type is not something a moderator can
 * read three hundred of.
 */
export const INTERVIEW_PREPARATION = [
  "REC_CODE_PRACTICE",
  "REC_CODE_CONTESTS",
  "APTITUDE_PRACTICE",
  "MOCK_INTERVIEWS",
  "CORE_CS_REVISION",
  "PROJECT_DEEP_DIVE",
  "RESUME_REVIEW",
] as const;
export type InterviewPreparation = (typeof INTERVIEW_PREPARATION)[number];

export const INTERVIEW_PREPARATION_LABEL: Readonly<Record<InterviewPreparation, string>> = Object.freeze({
  REC_CODE_PRACTICE: "Practising problems here",
  REC_CODE_CONTESTS: "Contests here",
  APTITUDE_PRACTICE: "Aptitude practice",
  MOCK_INTERVIEWS: "Mock interviews",
  CORE_CS_REVISION: "Revising core CS",
  PROJECT_DEEP_DIVE: "Knowing my own projects well",
  RESUME_REVIEW: "Getting my resume looked at",
});

export const INTERVIEW_STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const;
export type InterviewStatus = (typeof INTERVIEW_STATUSES)[number];

/** Where a row came from: a student, or the pre-launch collection. */
export const INTERVIEW_SOURCES = ["STUDENT", "BOOTSTRAP"] as const;
export type InterviewSource = (typeof INTERVIEW_SOURCES)[number];

export const INTERVIEW_LIMITS = Object.freeze({
  /** A company nobody has entered yet. The one free-text field there is. */
  companyName: { min: 2, max: 80 },
  /** Problems named from the catalogue, per experience. */
  problems: { min: 0, max: 12 },
  topics: { min: 0, max: TOPICS.length },
  rounds: { min: 1, max: 12 },
  durationMinutes: { min: 5, max: 600 },
  /** A moderator's reason, which the student is shown. */
  decisionReason: { min: 10, max: 500 },
});

/** The earliest interview the archive accepts, as a campus year. */
export const INTERVIEW_EARLIEST_YEAR = 2020;

export interface InterviewFacts {
  readonly roundKind: InterviewRoundKind;
  readonly topics: readonly Topic[];
  readonly problemIds: readonly string[];
}

/** Every topic is one of the fourteen; no duplicates. */
export function topicsAreValid(topics: readonly string[]): topics is Topic[] {
  const known = new Set<string>(TOPICS);
  return topics.every((t) => known.has(t)) && new Set(topics).size === topics.length;
}

export const INTERVIEW_REFUSALS = Object.freeze({
  notYours: "That is not yours to change.",
  alreadyDecided: "A moderator has already decided this one.",
  futureYear: "An interview cannot have happened in a year that has not started.",
  tooOld: `The archive goes back to ${INTERVIEW_EARLIEST_YEAR}. Anything older is about a company that has changed.`,
  noCompany: "Say which company it was.",
  duplicateProblem: "Name each problem once.",
  pendingLimit:
    "You have three submissions waiting for a moderator. They will be read — add the next one when one of these is through.",
});

/** Nobody may have more than this many waiting at once (a queue is a person's time). */
export const INTERVIEW_PENDING_LIMIT = 3;

/**
 * How an experience is shown to students: never a name, and never a batch
 * and department narrow enough to be one.
 *
 * A rejection with a name on it is a thing students do not post, and an
 * archive nobody posts to is worth nothing. The batch year is kept because
 * "2024" is what tells the reader whether the account is still current;
 * the department is kept because the question set differs; the section is
 * NOT, because batch + department + section is three or four people.
 */
export function anonymousAuthor(input: { batchYear: number | null; departmentCode: string | null }): string {
  const code = input.departmentCode;
  if (code && input.batchYear) return `${article(code)} ${code} student, batch of ${input.batchYear}`;
  if (input.batchYear) return `A student, batch of ${input.batchYear}`;
  if (code) return `${article(code)} ${code} student`;
  return "A student";
}

/**
 * "An ECE student", "A CSE student".
 *
 * Department codes are read letter by letter, so the article follows the
 * sound of the FIRST LETTER'S NAME rather than whether it is a vowel: A,
 * E, F, H, I, L, M, N, O, R, S and X all begin with a vowel sound when
 * spoken aloud. Worth the eleven characters — this string is the only
 * thing standing in for a student's name, and it is read hundreds of times
 * a page.
 */
function article(code: string): "A" | "An" {
  return /^[AEFHILMNORSX]/i.test(code) ? "An" : "A";
}

/**
 * Whether a company's tags may be presented as drawn from real interviews.
 *
 * Until the archive has data, the catalogue shows placement-cell CURATED
 * tracks, and SPEC §11 requires them to be "explicitly labelled as
 * curated". That label is not decoration: a curated track is somebody's
 * best guess, and a student choosing what to revise the night before is
 * entitled to know which it is.
 */
export const COMPANY_TAG_SOURCES = ["CURATED", "EXPERIENCE"] as const;
export type CompanyTagSource = (typeof COMPANY_TAG_SOURCES)[number];

export function companyTagNotice(source: CompanyTagSource, experiences: number, alsoCurated = false): string {
  if (source === "CURATED") {
    return "Curated by the placement cell — the college's best guess at what this company asks, not a record of what it asked.";
  }
  const counted = experiences === 1 ? "one interview a student reported here" : `${experiences} interviews students reported here`;
  /**
   * A track can be both: the placement cell curated it before anybody had
   * sat one, and students have reported some since. Saying so is the
   * point of the label — a reader deciding what to revise should not have
   * to guess which half of the list came from where.
   */
  return alsoCurated
    ? `From ${counted}, alongside the placement cell's own curation.`
    : `From ${counted}.`;
}

/**
 * Which label a company's track gets.
 *
 * Keyed on whether anybody has REPORTED an interview, not on whether a tag
 * happens to carry the EXPERIENCE source. A company with approved accounts
 * whose tags have all been reversed back to zero still has those accounts
 * behind it, and calling that "curated" would be a plain untruth.
 */
export function companyTagSource(approvedExperiences: number): CompanyTagSource {
  return approvedExperiences > 0 ? "EXPERIENCE" : "CURATED";
}
