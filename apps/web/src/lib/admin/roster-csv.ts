import { ROSTER_COLUMNS, ROSTER_IMPORT_LIMITS, rosterRowSchema, type RosterRow } from "@recx/shared";

/**
 * The roster CSV reader (RFC 4180): quoted fields, doubled quotes, commas and
 * line breaks inside quotes, CRLF or LF line ends, a UTF-8 byte-order mark.
 * The header must be exactly ROSTER_COLUMNS, in order. No dependency.
 * Pure: unit-tested in test/roster-csv.test.ts.
 */

export interface CsvLine {
  /** 1-based line number in the file where the record starts. */
  line: number;
  cells: Record<string, string>;
}

export interface CsvIssue {
  line: number;
  message: string;
}

export interface ParsedRosterCsv {
  header: string[];
  rows: CsvLine[];
  /** File-level problems (header, limits, malformed quoting). Any one means nothing is imported. */
  errors: CsvIssue[];
}

interface RawRecord {
  line: number;
  fields: string[];
}

/** Split CSV text into records. Unterminated quotes are reported, not guessed. */
function records(text: string): { records: RawRecord[]; errors: CsvIssue[] } {
  const out: RawRecord[] = [];
  const errors: CsvIssue[] = [];
  let fields: string[] = [];
  let field = "";
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let fieldStarted = false;
  let quotedField = false;

  const endField = () => {
    fields.push(field);
    field = "";
    fieldStarted = false;
    quotedField = false;
  };
  const endRecord = () => {
    endField();
    // A completely empty line is skipped (not a record).
    if (!(fields.length === 1 && fields[0] === "")) out.push({ line: recordLine, fields });
    fields = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (c === "\n") line++;
        field += c;
      }
      continue;
    }
    if (c === '"') {
      if (fieldStarted && !quotedField) {
        errors.push({ line, message: "A quote appears inside an unquoted field. Quote the whole field." });
      }
      inQuotes = true;
      quotedField = true;
      fieldStarted = true;
      continue;
    }
    if (c === ",") {
      endField();
      continue;
    }
    if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRecord();
      line++;
      recordLine = line;
      continue;
    }
    if (quotedField) {
      errors.push({ line, message: "Text follows a closing quote. Quote the whole field." });
      quotedField = false;
    }
    field += c;
    fieldStarted = true;
  }
  if (inQuotes) errors.push({ line: recordLine, message: "A quoted field is never closed." });
  if (field !== "" || fields.length > 0 || fieldStarted) endRecord();
  return { records: out, errors };
}

export function parseRosterCsv(input: string): ParsedRosterCsv {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const errors: CsvIssue[] = [];
  if (Buffer.byteLength(input, "utf8") > ROSTER_IMPORT_LIMITS.maxBytes) {
    return {
      header: [],
      rows: [],
      errors: [{ line: 0, message: `The file is larger than ${Math.round(ROSTER_IMPORT_LIMITS.maxBytes / 1024)} KB.` }],
    };
  }
  const split = records(text);
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
