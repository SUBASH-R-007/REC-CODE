import { z } from "zod";

/**
 * The LMS roster export that /admin/students/import accepts. REC Code never
 * creates an identity of its own: every row copies a person who already
 * exists in the LMS, so a row without an LMS user id is refused.
 *
 * The file is a CSV whose header is exactly these columns, in this order.
 */
export const ROSTER_COLUMNS = [
  "lmsUserId",
  "collegeId",
  "email",
  "firstName",
  "lastName",
  "batchYear",
  "departmentCode",
  "section",
] as const;

export type RosterColumn = (typeof ROSTER_COLUMNS)[number];

/**
 * 5,000 rows is the whole college; 900 KB keeps the upload under Next's
 * default 1 MB server-action body, so no framework setting changes.
 */
export const ROSTER_IMPORT_LIMITS = Object.freeze({ maxRows: 5000, maxBytes: 900 * 1024 } as const);

const emptyToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);

/** One validated roster row. Cells arrive as strings; numbers are coerced. */
export const rosterRowSchema = z.object({
  lmsUserId: z
    .string()
    .trim()
    .min(1, "The LMS user id is missing.")
    .max(64, "The LMS user id is longer than 64 characters.")
    .regex(/^[A-Za-z0-9_.:-]+$/, "The LMS user id may contain only letters, digits, '_', '.', ':' and '-'."),
  collegeId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{4,32}$/, "The roll number must be 4–32 letters or digits."),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(254, "The email address is longer than 254 characters.")
    .email("The email address is not valid."),
  firstName: z.string().trim().min(1, "The first name is missing.").max(80, "The first name is longer than 80 characters."),
  lastName: z.string().trim().max(80, "The last name is longer than 80 characters."),
  batchYear: z.coerce
    .number({ invalid_type_error: "The batch year must be a year." })
    .int("The batch year must be a year.")
    .min(2000, "The batch year must be between 2000 and 2100.")
    .max(2100, "The batch year must be between 2000 and 2100."),
  departmentCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2,10}$/, "The department code must be 2–10 letters."),
  section: z.preprocess(
    emptyToNull,
    z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{1,4}$/, "The section must be 1–4 letters or digits.")
      .nullable(),
  ),
});

export type RosterRow = z.output<typeof rosterRowSchema>;
