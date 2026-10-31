import { describe, expect, it } from "vitest";
import { ROSTER_COLUMNS, ROSTER_IMPORT_LIMITS } from "@recx/shared";
import { parseRosterCsv, validateRosterLines } from "@/lib/admin/roster-csv";

/** The roster CSV reader: RFC 4180 quoting, line ends, BOM, the exact header and the limits. */

const HEADER = ROSTER_COLUMNS.join(",");
const BOM = String.fromCharCode(0xfeff);
const row = (cells: Partial<Record<(typeof ROSTER_COLUMNS)[number], string>> = {}) =>
  ROSTER_COLUMNS.map(
    (c) =>
      cells[c] ??
      {
        lmsUserId: "lms-1",
        collegeId: "2116231001001",
        email: "priya@example.edu",
        firstName: "Priya",
        lastName: "Sharma",
        batchYear: "2027",
        departmentCode: "CSE",
        section: "A",
      }[c],
  ).join(",");

describe("parseRosterCsv", () => {
  it("reads a plain file with LF line ends", () => {
    const parsed = parseRosterCsv(`${HEADER}\n${row()}\n`);
    expect(parsed.errors).toEqual([]);
    expect(parsed.header).toEqual([...ROSTER_COLUMNS]);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({ line: 2, cells: { collegeId: "2116231001001", section: "A" } });
  });

  it("reads CRLF line ends and a byte-order mark", () => {
    const parsed = parseRosterCsv(`${BOM}${HEADER}\r\n${row()}\r\n${row({ lmsUserId: "lms-2" })}\r\n`);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows.map((r) => r.line)).toEqual([2, 3]);
  });

  it("handles quoted fields with commas, doubled quotes and line breaks", () => {
    const text = `${HEADER}\n${row({ firstName: '"Ravi, Jr."', lastName: '"O""Neil"' })}\n${row({
      lmsUserId: "lms-2",
      lastName: '"Two\nLines"',
    })}\n${row({ lmsUserId: "lms-3" })}`;
    const parsed = parseRosterCsv(text);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0]!.cells.firstName).toBe("Ravi, Jr.");
    expect(parsed.rows[0]!.cells.lastName).toBe('O"Neil');
    expect(parsed.rows[1]!.cells.lastName).toBe("Two\nLines");
    // The record after a quoted line break starts on its real line.
    expect(parsed.rows.map((r) => r.line)).toEqual([2, 3, 5]);
  });

  it("skips blank lines and keeps a last line without a newline", () => {
    const parsed = parseRosterCsv(`${HEADER}\n\n${row()}\n\n${row({ lmsUserId: "lms-2" })}`);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows.map((r) => r.line)).toEqual([3, 5]);
  });

  it("refuses a header that is not exactly the columns in order", () => {
    const swapped = [...ROSTER_COLUMNS];
    [swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];
    expect(parseRosterCsv(`${swapped.join(",")}\n${row()}`).errors[0]!.message).toMatch(/header must be exactly/);
    expect(parseRosterCsv(`${HEADER},extra\n${row()}`).errors[0]!.message).toMatch(/header must be exactly/);
  });

  it("reports a row with the wrong number of fields, an unclosed quote and an empty file", () => {
    expect(parseRosterCsv(`${HEADER}\na,b,c`).errors[0]!.message).toMatch(/has 3 fields; 8 are expected/);
    expect(parseRosterCsv(`${HEADER}\n"unclosed,${row()}`).errors.map((e) => e.message)).toContain("A quoted field is never closed.");
    expect(parseRosterCsv("").errors[0]!.message).toBe("The file is empty.");
  });

  it("enforces the 5,000-row limit", () => {
    const lines = Array.from({ length: ROSTER_IMPORT_LIMITS.maxRows + 1 }, (_, i) => row({ lmsUserId: `l${i}` }));
    const parsed = parseRosterCsv(`${HEADER}\n${lines.join("\n")}`);
    expect(parsed.errors.map((e) => e.message).join(" ")).toMatch(/5001 rows; at most 5000/);
    expect(parsed.rows).toHaveLength(ROSTER_IMPORT_LIMITS.maxRows);
  });

  it("enforces the 900 KB limit", () => {
    const big = `${HEADER}\n${"x".repeat(ROSTER_IMPORT_LIMITS.maxBytes)}`;
    expect(parseRosterCsv(big).errors[0]!.message).toMatch(/larger than 900 KB/);
  });
});

describe("validateRosterLines", () => {
  it("separates clean rows, missing LMS ids and invalid rows, keeping no cell values for refused rows", () => {
    const parsed = parseRosterCsv(
      [HEADER, row(), row({ lmsUserId: " " }), row({ lmsUserId: "lms-3", email: "not-an-email" })].join("\n"),
    );
    const lines = validateRosterLines(parsed.rows);
    expect(lines[0]).toMatchObject({ line: 2, error: null, row: { lmsUserId: "lms-1", batchYear: 2027 } });
    expect(lines[1]).toEqual({ line: 3, row: null, error: { reason: "MISSING_LMS_ID", message: "The LMS user id is missing." } });
    expect(lines[2]).toEqual({ line: 4, row: null, error: { reason: "INVALID_ROW", message: "The email address is not valid." } });
    expect(JSON.stringify(lines[2])).not.toContain("not-an-email");
  });
});
