/**
 * An RFC 4180 CSV reader: quoted fields, doubled quotes, commas and line
 * breaks inside quotes, CRLF or LF line ends, a UTF-8 byte-order mark.
 * No dependency, and no guessing — malformed quoting is REPORTED with a line
 * number rather than repaired, because a repaired row is a row somebody is
 * graded on.
 *
 * Lifted unchanged out of `apps/web/src/lib/admin/roster-csv.ts`, where it
 * was private, because Phase 7 needs the same reader for the aptitude
 * question bank (SPEC §5: "Reuse the LMS question-bank CSV import/export
 * pipeline with per-row results"). `roster-csv.ts` now imports it, and its
 * existing unit tests are left untouched as the proof the move changed no
 * behaviour.
 *
 * The one deliberate difference from the original: byte length is counted
 * with `TextEncoder` rather than `Buffer.byteLength`, because this package is
 * reachable from the browser and `Buffer` is not. Both count UTF-8 bytes.
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

export interface CsvRecord {
  line: number;
  fields: string[];
}

export interface ParsedCsv {
  header: string[];
  rows: CsvLine[];
  /**
   * File-level problems: the header, the limits, malformed quoting, and a
   * row with the wrong number of fields. Any one of them means nothing in
   * the file is trusted — which is different from a row that fails
   * validation, and is why the two live in different places.
   */
  errors: CsvIssue[];
}

/** UTF-8 bytes, counted the way a size limit means it. */
export function csvByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Strip a UTF-8 byte-order mark, which Excel writes and nothing wants. */
export function stripBom(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}

/** Split CSV text into records. Unterminated quotes are reported, not guessed. */
export function splitCsvText(text: string): { records: CsvRecord[]; errors: CsvIssue[] } {
  const out: CsvRecord[] = [];
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

export interface CsvShape {
  /** The header, exactly, in order. */
  readonly columns: readonly string[];
  readonly maxRows: number;
  readonly maxBytes: number;
  /**
   * Columns that may be absent from the header. Everything else must be
   * present and in order. Used by the aptitude importer so a file exported
   * from the LMS question bank — which has no `area` or `topic` column —
   * still imports.
   */
  readonly optionalColumns?: readonly string[];
}

/**
 * Read a CSV against a declared shape.
 *
 * Returns every file-level problem rather than the first, because an operator
 * fixing a 300-row export should see the whole list rather than discovering
 * the next one on each upload.
 */
export function parseCsvRecords(input: string, shape: CsvShape): ParsedCsv {
  const errors: CsvIssue[] = [];
  if (csvByteLength(input) > shape.maxBytes) {
    return {
      header: [],
      rows: [],
      errors: [
        {
          line: 0,
          message: `The file is larger than ${Math.round(shape.maxBytes / 1024)} KB. Split it and upload the parts.`,
        },
      ],
    };
  }

  const split = splitCsvText(stripBom(input));
  errors.push(...split.errors);
  const [head, ...body] = split.records;
  if (!head) return { header: [], rows: [], errors: [{ line: 1, message: "The file is empty." }, ...errors] };

  const header = head.fields.map((h) => h.trim());
  const optional = new Set(shape.optionalColumns ?? []);
  const required = shape.columns.filter((column) => !optional.has(column));
  const missing = required.filter((column) => !header.includes(column));
  const unknown = header.filter((column) => !shape.columns.includes(column));
  if (missing.length > 0) {
    errors.unshift({ line: head.line, message: `The header is missing: ${missing.join(", ")}.` });
  }
  if (unknown.length > 0) {
    // Named rather than ignored: a column nobody reads is usually a typo in
    // one that somebody meant to be read.
    errors.unshift({ line: head.line, message: `The header has columns nothing reads: ${unknown.join(", ")}.` });
  }
  if (body.length > shape.maxRows) {
    errors.push({
      line: 0,
      message: `The file has ${body.length} rows; at most ${shape.maxRows} are allowed in one upload.`,
    });
  }

  const rows: CsvLine[] = [];
  for (const record of body.slice(0, shape.maxRows)) {
    if (record.fields.length !== header.length) {
      errors.push({
        line: record.line,
        message: `Line ${record.line} has ${record.fields.length} fields; ${header.length} are expected.`,
      });
      continue;
    }
    const cells: Record<string, string> = {};
    // Keyed by the FILE's header, not by the declared column list, so a file
    // whose optional columns are absent does not get empty strings invented
    // for them — the row schema's own defaults decide what absent means.
    header.forEach((column, index) => {
      cells[column] = record.fields[index]!;
    });
    rows.push({ line: record.line, cells });
  }
  return { header, rows, errors };
}

/**
 * CSV WRITING, lifted unchanged from `apps/web/src/lib/privileged/csv.ts`
 * (which now re-exports it) so there is one definition rather than a second,
 * weaker one for the aptitude export.
 *
 * Every cell is quoted, and a cell a spreadsheet would read as a formula (it
 * starts with = + - @, a tab or a carriage return) is prefixed with an
 * apostrophe first — so an opened export can never run a formula planted in
 * a name, a question stem or an option.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  let text: string;
  if (value === null || value === undefined) text = "";
  else if (value instanceof Date) text = value.toISOString();
  else text = String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function csvRow(values: readonly unknown[]): string {
  return `${values.map(csvCell).join(",")}\r\n`;
}
