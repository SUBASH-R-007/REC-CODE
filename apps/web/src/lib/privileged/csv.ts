/**
 * CSV for the PII export. Pure. Every cell is quoted, and a cell that a
 * spreadsheet would read as a formula (it starts with = + - @, a tab or a
 * carriage return) is prefixed with an apostrophe first, so an opened
 * export can never run a formula planted in a name.
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
