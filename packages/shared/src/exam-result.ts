import { markMcqs, type McqTotals } from "./exam-mcq";
import { moderatedMark, type QuestionModeration } from "./exam-moderation";
import type { Verdict } from "./verdict";

/**
 * The result of a sitting (Phase 12y).
 *
 * Phase 12r marked the multiple-choice half and said, correctly for that
 * slice, that there was no score column to write. The other half was never
 * added: a coding question is judged and the verdict lands on the
 * `Submission`, and nothing ever added the two halves together. So a paper
 * could be authored, sat, invigilated and handed in, and no one — not the
 * candidate, not the examiner — could be told what it came to.
 * `AssessmentAttempt.totalScore` and `maxScore` have existed since Phase 6b
 * and no code has ever written either.
 *
 * The arithmetic is here, where it can be read without a database, for the
 * same reason the MCQ marking is: these numbers decide what a department
 * believes about a student, and a disputed one has to be reproducible from
 * its inputs.
 *
 * Four rules, each a decision rather than a default:
 *
 *   - **A question still being judged is not a zero.** It is pending, the
 *     result says so, and the total is marked PROVISIONAL. An exam whose
 *     last submission is still in the queue must not show a candidate's
 *     score as if it were final — that is how somebody gets told they
 *     failed by a progress bar.
 *   - **An internal error is not the candidate's fault.** `IE` means the
 *     judge broke, not that the answer was wrong, so it earns nothing yet
 *     and is reported as needing a human. A silent zero for a sandbox that
 *     crashed is the single most unfair thing this file could do.
 *   - **Partial credit is the judge's fraction of the paper's points.** A
 *     problem's own scoring (subtasks, test weights) decides what fraction
 *     was earned; the paper decides how much that question is worth. A
 *     question worth 10 marks on a paper whose judge scored 30/60 earns 5.
 *   - **Blank is zero and says so.** Same as the MCQ half: a question the
 *     candidate never answered reads differently to staff than one they
 *     got wrong, even though both score nothing.
 */

/** What became of one coding question in a sitting. */
export type CodingOutcome =
  /** Full marks: the judge accepted it. */
  | "accepted"
  /** Some marks: the judge scored a fraction. */
  | "partial"
  /** No marks: wrong, too slow, crashed, or would not compile. */
  | "rejected"
  /** Judged nothing yet — queued or running. Not a zero. */
  | "pending"
  /** The judge failed on it (IE). Not a zero, and not the candidate's fault. */
  | "unjudged"
  /** Nothing was handed in for this question. */
  | "blank"
  /** Phase 13i: moderated to full marks for everybody. */
  | "awarded"
  /** Phase 13i: withdrawn from the paper, for everybody. */
  | "dropped";

export interface CodingMarkingInput {
  /** The paper's question, not the problem: a paper may ask the same problem twice. */
  readonly questionId: string;
  /** What this question is worth on this paper. */
  readonly points: number;
  /** The candidate's submission for it, or null when they left it blank. */
  readonly submission: {
    readonly verdict: Verdict | null;
    /** The judge's own score for the problem, in the problem's own scale. */
    readonly score: number | null;
    readonly maxScore: number | null;
    /** False while the row is QUEUED or JUDGING. */
    readonly terminal: boolean;
    /**
     * The toolchain key it was judged with (Phase 13a), carried through to
     * the mark.
     *
     * It was not worth reporting while a paper had one language that
     * nobody chose. Now that a candidate picks per question, "what was
     * this answered in" is a question the result has to be able to
     * answer: a department comparing two candidates, and a candidate
     * reading their own marks, both need it, and an examiner looking at a
     * wrong answer in a language the paper was not taught in is looking at
     * something else entirely.
     */
    readonly language?: string | null;
  } | null;
  /**
   * Phase 13i: awarded to everyone, or dropped from the paper. Absent
   * means NONE.
   */
  readonly moderation?: QuestionModeration;
}

export interface CodingMark {
  readonly questionId: string;
  readonly outcome: CodingOutcome;
  readonly verdict: Verdict | null;
  readonly points: number;
  readonly maxPoints: number;
  /**
   * What it was answered in (Phase 13a), or null for a blank question --
   * which has no language because there is nothing to have written one in.
   */
  readonly language: string | null;
}

export interface CodingTotals {
  readonly marks: readonly CodingMark[];
  readonly points: number;
  readonly maxPoints: number;
  readonly accepted: number;
  readonly partial: number;
  readonly rejected: number;
  readonly pending: number;
  readonly unjudged: number;
  readonly blank: number;
  /** Phase 13i: awarded to everyone, and withdrawn from the paper. */
  readonly awarded: number;
  readonly dropped: number;
}

/** Verdicts that earn nothing and are the candidate's own result. */
const REJECTED: readonly Verdict[] = ["WA", "TLE", "MLE", "RE", "CE", "OLE", "SKIPPED"];

export function markCoding(input: CodingMarkingInput): CodingMark {
  const maxPoints = input.points;
  const submission = input.submission;
  // On the base, so every outcome below carries it and none can forget to.
  const base = { questionId: input.questionId, maxPoints, language: submission?.language ?? null };

  /**
   * Moderation first (Phase 13i), before even "was anything handed in":
   * a question dropped from the paper is worth nothing to anybody, and
   * one awarded to everyone is worth its marks to the candidate who
   * never reached it as much as to the one who answered it.
   */
  const moderated = moderatedMark(input.moderation, maxPoints);
  if (moderated) return { ...base, verdict: submission?.verdict ?? null, ...moderated };

  if (submission === null) return { ...base, outcome: "blank", verdict: null, points: 0, language: null };
  if (!submission.terminal || submission.verdict === null) {
    return { ...base, outcome: "pending", verdict: submission.verdict, points: 0 };
  }
  if (submission.verdict === "IE") return { ...base, outcome: "unjudged", verdict: "IE", points: 0 };
  if (submission.verdict === "AC") return { ...base, outcome: "accepted", verdict: "AC", points: maxPoints };

  if (submission.verdict === "PARTIAL") {
    const { score, maxScore } = submission;
    /**
     * A PARTIAL with no usable fraction is reported as unjudged rather
     * than guessed at. Scoring it zero would punish the candidate for a
     * judge that answered badly, and scoring it full would hand marks to
     * everybody the moment a checker misbehaves.
     */
    if (score === null || maxScore === null || !(maxScore > 0) || !Number.isFinite(score)) {
      return { ...base, outcome: "unjudged", verdict: "PARTIAL", points: 0 };
    }
    const fraction = Math.min(Math.max(score / maxScore, 0), 1);
    return { ...base, outcome: "partial", verdict: "PARTIAL", points: maxPoints * fraction };
  }

  if (REJECTED.includes(submission.verdict)) {
    return { ...base, outcome: "rejected", verdict: submission.verdict, points: 0 };
  }
  // A verdict this function has not been taught. Never silently zero.
  return { ...base, outcome: "unjudged", verdict: submission.verdict, points: 0 };
}

export function markCodingQuestions(inputs: readonly CodingMarkingInput[]): CodingTotals {
  const marks = inputs.map(markCoding);
  const count = (outcome: CodingOutcome) => marks.filter((m) => m.outcome === outcome).length;
  return {
    marks,
    points: marks.reduce((sum, m) => sum + m.points, 0),
    maxPoints: marks.reduce((sum, m) => sum + m.maxPoints, 0),
    accepted: count("accepted"),
    partial: count("partial"),
    rejected: count("rejected"),
    pending: count("pending"),
    unjudged: count("unjudged"),
    blank: count("blank"),
    awarded: count("awarded"),
    dropped: count("dropped"),
  };
}

export interface AttemptResult {
  readonly mcq: McqTotals;
  readonly coding: CodingTotals;
  readonly points: number;
  readonly maxPoints: number;
  /** null when the paper is worth nothing, rather than a misleading 0 %. */
  readonly percent: number | null;
  /**
   * True while any coding question is still being judged, or was left
   * unjudged by a broken judge. A provisional total is not a result.
   */
  readonly provisional: boolean;
  /** Questions a human has to look at: a judge that failed, or a corrupt answer. */
  readonly needsAttention: number;
}

export function scoreAttempt(args: {
  readonly mcqs: Parameters<typeof markMcqs>[0];
  readonly coding: readonly CodingMarkingInput[];
}): AttemptResult {
  const mcq = markMcqs(args.mcqs);
  const coding = markCodingQuestions(args.coding);
  const points = mcq.points + coding.points;
  const maxPoints = mcq.maxPoints + coding.maxPoints;
  return {
    mcq,
    coding,
    points,
    maxPoints,
    percent: maxPoints > 0 ? (points / maxPoints) * 100 : null,
    provisional: coding.pending > 0 || coding.unjudged > 0,
    needsAttention: coding.unjudged + mcq.corrupt,
  };
}

/** Marks as a department writes them: at most two decimals, no trailing zeroes. */
export function formatMarks(points: number): string {
  return Number.isInteger(points) ? String(points) : String(Math.round(points * 100) / 100);
}
