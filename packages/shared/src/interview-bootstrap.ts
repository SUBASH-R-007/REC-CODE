import type { CsvShape } from "./csv";
import {
  INTERVIEW_EARLIEST_YEAR,
  INTERVIEW_LIMITS,
  INTERVIEW_MODES,
  INTERVIEW_OUTCOMES,
  INTERVIEW_PREPARATION,
  INTERVIEW_ROUND_KINDS,
  type InterviewMode,
  type InterviewOutcome,
  type InterviewPreparation,
  type InterviewRoundKind,
} from "./interview-archive";
import { TOPICS, type Topic } from "./topics";

/**
 * The pre-launch interview-archive collection, as a file (Phase 16q,
 * `docs/ROADMAP.md` §1.7).
 *
 * SPEC §11 calls the moderated archive load-bearing rather than a nicety —
 * the only legal and genuinely REC-specific source of company tags and
 * "asked at" frequency — and asks for a one-time structured collection from
 * the two most recent graduated batches before launch. §1.7 says "the
 * software is ready for it".
 *
 * **It was not.** `InterviewSource.BOOTSTRAP` existed, the CHECK
 * `InterviewExperience_author_check` allowed a row with no author precisely
 * so a bootstrap row could have none, a query knew how to label one, and a
 * database test inserted one by hand — and **nothing in the product wrote
 * one**. The archive's only write path is `submitExperienceFor(userId)`,
 * the student's own form, which hardcodes `source: "STUDENT"`. So the
 * placement cell could run the survey and then had nowhere to put it.
 *
 * This is the shape of the file that survey becomes. It is deliberately the
 * same closed enumerations the student's form offers, because the archive's
 * whole value is that it is structured: a free-text box would have made the
 * bootstrap easy to collect and useless to query, which is the trade SPEC
 * §11 already refused.
 *
 * **Every list column is pipe-separated**, like the aptitude bank's
 * `options` — a comma inside a CSV field is a quoting problem nobody should
 * have to think about while typing sixty rows.
 */

export const INTERVIEW_BOOTSTRAP_COLUMNS = [
  "companyName",
  "role",
  "mode",
  "heldYear",
  "heldMonth",
  "rounds",
  "longestRoundMinutes",
  "outcome",
  "roundKinds",
  "topics",
  "preparation",
  "problemSlugs",
] as const;

export const INTERVIEW_BOOTSTRAP_CSV_SHAPE: CsvShape = Object.freeze({
  columns: INTERVIEW_BOOTSTRAP_COLUMNS,
  /**
   * Two graduated batches of a college this size is a few hundred accounts
   * at the very most, and a moderator reads every one of them. A file
   * larger than this is a sign that somebody has exported the wrong thing.
   */
  maxRows: 500,
  maxBytes: 512 * 1024,
  /** A survey that did not ask for these still imports. */
  optionalColumns: ["longestRoundMinutes", "topics", "preparation", "problemSlugs"],
});

/** The parsed row, ready for `submitExperienceSchema`, plus the slugs to resolve. */
export interface BootstrapRow {
  companyName: string;
  role: string;
  mode: InterviewMode;
  heldYear: number;
  heldMonth: number;
  rounds: number;
  longestRoundMinutes: number | null;
  outcome: InterviewOutcome;
  roundKinds: InterviewRoundKind[];
  topics: Topic[];
  preparation: InterviewPreparation[];
  /** Catalogue ADDRESSES, not ids: a survey cannot know a cuid. */
  problemSlugs: string[];
}

export interface BootstrapRowResult {
  row: BootstrapRow | null;
  /** Every problem with the row, not the first — one pass fixes the file. */
  issues: string[];
}

/** "A | B|c " → ["A", "B", "c"]; an empty field is an empty list. */
export function splitBootstrapList(value: string | undefined): string[] {
  return (value ?? "")
    .split("|")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * A closed enumeration, read case-insensitively and with spaces for
 * underscores — because a survey answer reads "On campus" and the enum is
 * `ON_CAMPUS`, and refusing the human spelling would mean somebody
 * rewriting a spreadsheet by hand.
 */
function matchEnum<T extends string>(allowed: readonly T[], raw: string): T | null {
  const wanted = raw.trim().toUpperCase().replace(/[\s-]+/g, "_");
  return allowed.find((value) => value.toUpperCase() === wanted) ?? null;
}

function matchList<T extends string>(
  allowed: readonly T[],
  raw: string | undefined,
  what: string,
  issues: string[],
): T[] {
  const out: T[] = [];
  for (const part of splitBootstrapList(raw)) {
    const hit = matchEnum(allowed, part);
    if (hit === null) {
      issues.push(`${what} "${part}" is not one of: ${allowed.join(", ")}`);
      continue;
    }
    if (out.includes(hit)) {
      issues.push(`${what} "${hit}" is named twice`);
      continue;
    }
    out.push(hit);
  }
  return out;
}

function wholeNumber(raw: string | undefined, what: string, issues: string[]): number | null {
  const text = (raw ?? "").trim();
  if (text === "") {
    issues.push(`${what} is empty`);
    return null;
  }
  if (!/^\d+$/.test(text)) {
    issues.push(`${what} is "${text}", which is not a whole number`);
    return null;
  }
  return Number(text);
}

/**
 * One CSV record → one row, or the reasons it is not one.
 *
 * PURE, and it refuses rather than guesses: a bootstrap row that is wrong
 * is read by a moderator as somebody's account of an interview, so a
 * silently coerced month or a misspelt outcome would become a fact about a
 * company that nobody said.
 */
export function bootstrapRowFrom(record: Readonly<Record<string, string>>, nowYear: number): BootstrapRowResult {
  const issues: string[] = [];

  const companyName = (record.companyName ?? "").trim();
  if (companyName.length < INTERVIEW_LIMITS.companyName.min) issues.push("companyName is empty or too short");
  if (companyName.length > INTERVIEW_LIMITS.companyName.max) {
    issues.push(`companyName is longer than ${INTERVIEW_LIMITS.companyName.max} characters`);
  }

  const role = (record.role ?? "").trim();
  if (role.length < 2) issues.push("role is empty or too short");

  const mode = matchEnum(INTERVIEW_MODES, record.mode ?? "");
  if (mode === null) issues.push(`mode is "${(record.mode ?? "").trim()}", not one of: ${INTERVIEW_MODES.join(", ")}`);

  const outcome = matchEnum(INTERVIEW_OUTCOMES, record.outcome ?? "");
  if (outcome === null) {
    issues.push(`outcome is "${(record.outcome ?? "").trim()}", not one of: ${INTERVIEW_OUTCOMES.join(", ")}`);
  }

  const heldYear = wholeNumber(record.heldYear, "heldYear", issues);
  if (heldYear !== null && (heldYear < INTERVIEW_EARLIEST_YEAR || heldYear > nowYear)) {
    issues.push(`heldYear ${heldYear} is outside ${INTERVIEW_EARLIEST_YEAR}–${nowYear}`);
  }
  const heldMonth = wholeNumber(record.heldMonth, "heldMonth", issues);
  if (heldMonth !== null && (heldMonth < 1 || heldMonth > 12)) issues.push(`heldMonth ${heldMonth} is not a month`);

  const rounds = wholeNumber(record.rounds, "rounds", issues);
  if (rounds !== null && (rounds < INTERVIEW_LIMITS.rounds.min || rounds > INTERVIEW_LIMITS.rounds.max)) {
    issues.push(`rounds ${rounds} is outside ${INTERVIEW_LIMITS.rounds.min}–${INTERVIEW_LIMITS.rounds.max}`);
  }

  /**
   * The one field a survey is allowed to leave blank with a MEANING: "we did
   * not ask how long the longest round was". Null is the archive's own way
   * of saying that, so an empty field is null and not a zero.
   */
  let longestRoundMinutes: number | null = null;
  const minutesText = (record.longestRoundMinutes ?? "").trim();
  if (minutesText !== "") {
    longestRoundMinutes = wholeNumber(minutesText, "longestRoundMinutes", issues);
    if (
      longestRoundMinutes !== null &&
      (longestRoundMinutes < INTERVIEW_LIMITS.durationMinutes.min ||
        longestRoundMinutes > INTERVIEW_LIMITS.durationMinutes.max)
    ) {
      issues.push(
        `longestRoundMinutes ${longestRoundMinutes} is outside ` +
          `${INTERVIEW_LIMITS.durationMinutes.min}–${INTERVIEW_LIMITS.durationMinutes.max}`,
      );
      longestRoundMinutes = null;
    }
  }

  const roundKinds = matchList(INTERVIEW_ROUND_KINDS, record.roundKinds, "roundKinds", issues);
  if (roundKinds.length === 0) issues.push("roundKinds names no kind of round");
  if (rounds !== null && roundKinds.length > rounds) {
    // Not a schema rule, and worth saying: more kinds than rounds means the
    // survey's two answers disagree, and a moderator cannot tell which.
    issues.push(`roundKinds names ${roundKinds.length} kinds for ${rounds} round(s)`);
  }

  const topics = matchList(TOPICS, record.topics, "topics", issues);
  if (topics.length > INTERVIEW_LIMITS.topics.max) issues.push("topics names more than the archive holds");

  const preparation = matchList(INTERVIEW_PREPARATION, record.preparation, "preparation", issues);

  const problemSlugs = splitBootstrapList(record.problemSlugs);
  if (problemSlugs.length > INTERVIEW_LIMITS.problems.max) {
    issues.push(`problemSlugs names ${problemSlugs.length} problems (limit ${INTERVIEW_LIMITS.problems.max})`);
  }
  if (new Set(problemSlugs).size !== problemSlugs.length) issues.push("problemSlugs names a problem twice");

  if (issues.length > 0) return { row: null, issues };

  return {
    row: {
      companyName,
      role,
      mode: mode!,
      heldYear: heldYear!,
      heldMonth: heldMonth!,
      rounds: rounds!,
      longestRoundMinutes,
      outcome: outcome!,
      roundKinds,
      topics,
      preparation,
      problemSlugs,
    },
    issues: [],
  };
}

/**
 * What makes two bootstrap rows the same account of the same interview, so
 * importing a file twice does not double every company tag.
 *
 * Not a hash of the whole row: a second pass of the same survey may have
 * tidied the topics or added the round length, and that is the same
 * interview with better notes. Company, role, month and outcome is what
 * identifies it — the four things the person being asked cannot misremember
 * differently on a Tuesday.
 */
export function bootstrapRowKey(row: Pick<BootstrapRow, "companyName" | "role" | "heldYear" | "heldMonth" | "outcome">): string {
  return [
    row.companyName.trim().toLowerCase().replace(/\s+/g, " "),
    row.role.trim().toLowerCase().replace(/\s+/g, " "),
    row.heldYear,
    row.heldMonth,
    row.outcome,
  ].join("\u0000");
}
