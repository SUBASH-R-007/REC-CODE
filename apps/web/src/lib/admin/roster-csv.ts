import {
  ROSTER_COLUMNS,
  ROSTER_IMPORT_LIMITS,
  csvByteLength,
  rosterRowSchema,
  splitCsvText,
  stripBom,
  type CsvIssue,
  type CsvLine,
  type RosterRow,
} from "@recx/shared";

/**
 * The roster CSV reader. The header must be exactly ROSTER_COLUMNS, in order.
 *
 * The RFC 4180 record splitter this used to carry privately — quoted fields,
 * doubled quotes, commas and line breaks inside quotes, CRLF or LF, a UTF-8
 * byte-order mark — moved to `packages/shared/src/csv.ts` when Phase 7 needed
 * the same reader for the aptitude question bank. The tests in
 * `test/roster-csv.test.ts` are untouched, which is what proves the move
 * changed no behaviour.
 *
 * The roster's header rule stays HERE rather than going to the shared reader:
 * it is stricter than the aptitude importer's (exact, in order, nothing
 * optional), and the message an operator reads names the roster's own
 * columns. Pure.
 */

export type { CsvIssue, CsvLine };

export interface ParsedRosterCsv {
  header: string[];
  rows: CsvLine[];
  /** File-level problems (header, limits, malformed quoting). Any one means nothing is imported. */
  errors: CsvIssue[];
}

export function parseRosterCsv(input: string): ParsedRosterCsv {
  const text = stripBom(input);
  const errors: CsvIssue[] = [];
  if (csvByteLength(input) > ROSTER_IMPORT_LIMITS.maxBytes) {
    return {
      header: [],
      rows: [],
      errors: [{ line: 0, message: `The file is larger than ${Math.round(ROSTER_IMPORT_LIMITS.maxBytes / 1024)} KB.` }],
    };
  }
  const split = splitCsvText(text);
  errors.push(...split.errors);
  const [head, ...body] = split.records;
  if (!head) return { header: [], rows: [], errors: [{ line: 1, message: "The file is empty." }, ...errors] };

  const header = head.fields.map((h) => h.trim());
  const expected = [...ROSTER_COLUMNS];
  if (header.length !== expected.length || header.some((h, i) => h !== expected[i])) {
    errors.unshift({ line: head.line, message: `The header must be exactly: ${expected.join(",")}` });
  }
  if (body.length > ROSTER_IMPORT_LIMITS.maxRows) {
    errors.push({ line: 0, message: `The file has ${body.length} rows; at most ${ROSTER_IMPORT_LIMITS.maxRows} are allowed.` });
  }
  const rows: CsvLine[] = [];
  for (const record of body.slice(0, ROSTER_IMPORT_LIMITS.maxRows)) {
    if (record.fields.length !== expected.length) {
      errors.push({
        line: record.line,
        message: `Line ${record.line} has ${record.fields.length} fields; ${expected.length} are expected.`,
      });
      continue;
    }
    const cells: Record<string, string> = {};
    expected.forEach((col, i) => {
      cells[col] = record.fields[i]!;
    });
    rows.push({ line: record.line, cells });
  }
  return { header, rows, errors };
}

/** A roster line after validation: a clean row, or why it was refused (no cell values kept). */
export type ValidatedRosterLine =
  | { line: number; row: RosterRow; error: null }
  | { line: number; row: null; error: { reason: "MISSING_LMS_ID" | "INVALID_ROW"; message: string } };

export function validateRosterLines(lines: readonly CsvLine[]): ValidatedRosterLine[] {
  return lines.map(({ line, cells }) => {
    if ((cells.lmsUserId ?? "").trim() === "") {
      return { line, row: null, error: { reason: "MISSING_LMS_ID", message: "The LMS user id is missing." } };
    }
    const parsed = rosterRowSchema.safeParse(cells);
    if (parsed.success) return { line, row: parsed.data, error: null };
    const issue = parsed.error.issues[0];
    return { line, row: null, error: { reason: "INVALID_ROW", message: issue?.message ?? "The row is not valid." } };
  });
}
