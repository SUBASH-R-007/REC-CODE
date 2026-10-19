import type { AptitudeCsvQuestion } from "./aptitude-csv";

/**
 * Deciding what an import DOES, row by row (Phase 7d).
 *
 * SPEC §5: *Reuse the LMS question-bank CSV import/export pipeline with
 * per-row results, so one bad row cannot discard a 300-question file.*
 *
 * This module is the "what happens to each row" half, and it is pure so the
 * answer can be tested without a database and shown to an operator BEFORE
 * anything is written. The statuses are Phase 4's, reused verbatim
 * (`ProblemImportRowStatus`), because the shape of the answer is the same:
 *
 *   CREATED       — a question the bank does not have.
 *   NEW_REVISION  — a question it has, with something changed.
 *   UNCHANGED     — a question it has, identical. The round trip's own case.
 *   FAILED        — a row that cannot be applied, with every reason.
 *
 * The case the design left unstated, and the one most likely in practice:
 * an operator exports the bank, edits the stem of a PUBLISHED question, and
 * uploads it again. `recx_refuse_published_question_change` would refuse that
 * write and take the whole transaction with it — one edited row discarding
 * 299 good ones, which is precisely what the spec's clause forbids. So the
 * planner refuses it HERE, as a FAILED row with a sentence an operator can
 * act on, and the other 299 rows still land.
 */

export const APTITUDE_ROW_STATUSES = ["CREATED", "NEW_REVISION", "UNCHANGED", "FAILED"] as const;
export type AptitudeRowStatus = (typeof APTITUDE_ROW_STATUSES)[number];

/** A question already in the bank, as the planner needs to see it. */
export interface ExistingQuestion {
  readonly id: string;
  readonly displayCode: string;
  readonly contentHash: string;
  readonly status: "DRAFT" | "IN_REVIEW" | "PUBLISHED" | "RETIRED";
}

/** One row, after `rowToQuestion` and before anything is written. */
export interface PlannedRow {
  readonly line: number;
  readonly status: AptitudeRowStatus;
  /** Null for a FAILED row. */
  readonly question: AptitudeCsvQuestion | null;
  /** The question this row updates, if it matched one. */
  readonly questionId: string | null;
  readonly displayCode: string | null;
  readonly contentHash: string | null;
  readonly needsPassage: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export interface ImportPlan {
  readonly rows: readonly PlannedRow[];
  readonly created: number;
  readonly revised: number;
  readonly unchanged: number;
  readonly failed: number;
  readonly total: number;
}

/** One row as it arrives from the CSV layer. */
export type ReadRow =
  | {
      readonly line: number;
      readonly ok: true;
      readonly question: AptitudeCsvQuestion;
      readonly code: string | null;
      readonly contentHash: string;
      readonly needsPassage: boolean;
      readonly warnings: readonly string[];
    }
  | { readonly line: number; readonly ok: false; readonly errors: readonly string[]; readonly warnings: readonly string[] };

/**
 * Decide what each row does.
 *
 * The matching rule, in order: a row's `code` if it has one, then its content
 * hash. A code is an explicit claim about WHICH question this is, so it wins;
 * the hash catches an upload of the same file twice, which is the commonest
 * accident and must not double the bank.
 */
export function planImport(rows: readonly ReadRow[], existing: readonly ExistingQuestion[]): ImportPlan {
  const byCode = new Map(existing.map((question) => [question.displayCode, question]));
  const byHash = new Map<string, ExistingQuestion>();
  for (const question of existing) if (!byHash.has(question.contentHash)) byHash.set(question.contentHash, question);

  /** Hashes this file has already used, so a file cannot fight itself. */
  const seenInFile = new Map<string, number>();
  const planned: PlannedRow[] = [];

  for (const row of rows) {
    if (!row.ok) {
      planned.push({
        line: row.line,
        status: "FAILED",
        question: null,
        questionId: null,
        displayCode: null,
        contentHash: null,
        needsPassage: false,
        errors: row.errors,
        warnings: row.warnings,
      });
      continue;
    }

    const base = {
      line: row.line,
      question: row.question,
      contentHash: row.contentHash,
      needsPassage: row.needsPassage,
      warnings: row.warnings,
    };

    // A file that holds the same question twice is a file whose second copy
    // would silently overwrite the first. Refused by line number, so the
    // operator can see both.
    const duplicateOf = seenInFile.get(row.contentHash);
    if (duplicateOf !== undefined) {
      planned.push({
        ...base,
        status: "FAILED",
        question: null,
        questionId: null,
        displayCode: row.code,
        errors: [`This question is identical to the one on line ${duplicateOf}. Remove one of them.`],
      });
      continue;
    }
    seenInFile.set(row.contentHash, row.line);

    const matched = (row.code !== null ? byCode.get(row.code) : undefined) ?? byHash.get(row.contentHash);

    if (!matched) {
      if (row.code !== null && !byCode.has(row.code)) {
        // A code the bank does not know. Created rather than refused: an
        // operator importing a file from another REC instance has codes that
        // are real there, and refusing them would make the file unusable.
        planned.push({ ...base, status: "CREATED", questionId: null, displayCode: row.code, errors: [] });
        continue;
      }
      planned.push({ ...base, status: "CREATED", questionId: null, displayCode: null, errors: [] });
      continue;
    }

    if (matched.contentHash === row.contentHash) {
      // The round trip's own case: an export re-imported with nothing
      // changed. Reported, not rewritten — a no-op write would bump
      // `updatedAt` on 2,000 rows and tell an operator nothing.
      planned.push({
        ...base,
        status: "UNCHANGED",
        questionId: matched.id,
        displayCode: matched.displayCode,
        errors: [],
      });
      continue;
    }

    if (matched.status === "PUBLISHED" || matched.status === "RETIRED") {
      // The case the design left unstated. `recx_refuse_published_question_change`
      // would refuse this write and roll back the whole file; refusing the
      // ROW instead is what keeps the other 299 landing.
      planned.push({
        ...base,
        status: "FAILED",
        question: null,
        questionId: matched.id,
        displayCode: matched.displayCode,
        errors: [
          `${matched.displayCode} is ${matched.status.toLowerCase()} and its wording, options and answer are frozen — students have already been scored on it. Retire it and add a new question, or edit only its explanation on the question page.`,
        ],
      });
      continue;
    }

    planned.push({
      ...base,
      status: "NEW_REVISION",
      questionId: matched.id,
      displayCode: matched.displayCode,
      errors: [],
    });
  }

  return {
    rows: planned,
    created: planned.filter((row) => row.status === "CREATED").length,
    // `revised`, not `updated`: the reused row status is NEW_REVISION, and
    // `ProblemImport` spells its counter the same way. A counter whose name
    // does not match the status it counts cannot be reconciled.
    revised: planned.filter((row) => row.status === "NEW_REVISION").length,
    unchanged: planned.filter((row) => row.status === "UNCHANGED").length,
    failed: planned.filter((row) => row.status === "FAILED").length,
    total: planned.length,
  };
}

/**
 * Group the passage rows of a plan.
 *
 * A CSV row cannot carry a database id, so the importer decides which rows
 * share a passage: consecutive PASSAGE_GROUPED rows of the same topic are
 * one group. Consecutive because that is how a human writes a passage's
 * questions in a spreadsheet — under the passage, together — and because any
 * cleverer rule would be a rule nobody could predict from looking at the
 * file.
 *
 * A group of fewer than two is refused: SPEC §5 says "one shared passage, N
 * questions", and a passage with one question is a stem with extra steps.
 */
export function passageGroups(rows: readonly PlannedRow[]): {
  groups: Array<{ lines: number[]; topic: string }>;
  errors: Array<{ line: number; message: string }>;
} {
  const groups: Array<{ lines: number[]; topic: string }> = [];
  const errors: Array<{ line: number; message: string }> = [];
  let current: { lines: number[]; topic: string } | null = null;

  const close = () => {
    if (!current) return;
    if (current.lines.length < 2) {
      errors.push({
        line: current.lines[0]!,
        message:
          "A passage needs at least two questions. Put the passage's questions on consecutive lines, or make this a single-choice question instead.",
      });
    } else {
      groups.push(current);
    }
    current = null;
  };

  for (const row of rows) {
    if (row.status === "FAILED" || !row.needsPassage || !row.question) {
      close();
      continue;
    }
    const topic = String(row.question.topic);
    if (current && current.topic === topic) current.lines.push(row.line);
    else {
      close();
      current = { lines: [row.line], topic };
    }
  }
  close();
  return { groups, errors };
}
