import "server-only";
import { z } from "zod";
import {
  IO_MODES,
  LANGUAGE_KEYS,
  LIMITS,
  SCORING_MODES,
  SQL_LANGUAGE_KEY,
  SUBTASK_AGGREGATIONS,
  TOPICS,
} from "@recx/shared";
import {
  AUTHORABLE_COMPARE_MODES,
  CONTENT_ORIGINS,
  DIFFICULTIES,
  IMPORT_LIMITS,
  MIN_MEMORY_LIMIT_KB,
  REFERENCE_EXPECTED_VERDICTS,
  displayCodeSchema,
  problemSlugSchema,
} from "@recx/shared/authoring";

/**
 * zod input schemas of every authoring action (src/server/actions/admin-
 * problems.ts and admin-problem-content.ts). The shared field rules live in
 * @recx/shared/authoring so the import package and the forms agree.
 */

export const idSchema = z.string().trim().min(1, "Missing id.").max(64, "Invalid id.");
export const editSeqSchema = z.number({ invalid_type_error: "Reload the page and try again." }).int().min(0);

const noNul = (s: string) => !s.includes("\u0000");
const utf8Bytes = (s: string) => Buffer.byteLength(s, "utf8");

export const titleSchema = z
  .string()
  .trim()
  .min(3, "The title is at least 3 characters.")
  .max(120, "The title is at most 120 characters.");

export const statementSchema = z
  .string()
  .max(IMPORT_LIMITS.statementBytes, "The statement is at most 64 KB.")
  .refine(noNul, "The statement contains a NUL character.")
  .refine((s) => utf8Bytes(s) <= IMPORT_LIMITS.statementBytes, "The statement is at most 64 KB.");

export const timeLimitSchema = z.coerce
  .number({ invalid_type_error: "Enter the time limit in milliseconds." })
  .int("Enter a whole number of milliseconds.")
  .min(LIMITS.cpuTime.floorMs, `The time limit is at least ${LIMITS.cpuTime.floorMs} ms.`)
  .max(LIMITS.cpuTime.ceilingMs, `The time limit is at most ${LIMITS.cpuTime.ceilingMs} ms (problems over 15 s are not accepted).`);

export const memoryLimitMbSchema = z.coerce
  .number({ invalid_type_error: "Enter the memory limit in MB." })
  .int("Enter a whole number of megabytes.")
  .min(MIN_MEMORY_LIMIT_KB / 1024, `The memory limit is at least ${MIN_MEMORY_LIMIT_KB / 1024} MB.`)
  .max(LIMITS.memory.ceilingKb / 1024, `The memory limit is at most ${LIMITS.memory.ceilingKb / 1024} MB (problems over 1 GB are not accepted).`);

/** A FUNCTION signature typed as JSON in a plain textarea; checked by the content rules, not here. */
export const signatureJsonSchema = z
  .string()
  .trim()
  .max(10_000, "The signature is at most 10,000 characters.")
  .transform((text, ctx) => {
    if (text.length === 0) return null;
    try {
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "The function signature must be a JSON object." });
        return z.NEVER;
      }
      return value as Record<string, unknown>;
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "The function signature is not valid JSON." });
      return z.NEVER;
    }
  });

export const createProblemSchema = z.object({
  slug: problemSlugSchema,
  displayCode: displayCodeSchema,
  title: titleSchema,
  difficulty: z.enum(DIFFICULTIES, { errorMap: () => ({ message: "Choose a difficulty." }) }),
  ioMode: z.enum(IO_MODES, { errorMap: () => ({ message: "Choose an input mode." }) }),
  compareMode: z.enum(AUTHORABLE_COMPARE_MODES, { errorMap: () => ({ message: "Choose a comparator: every problem declares one." }) }),
  functionSignature: signatureJsonSchema.optional(),
  statementMd: statementSchema.default(""),
  timeLimitMs: timeLimitSchema,
  memoryLimitMb: memoryLimitMbSchema,
  origin: z.enum(CONTENT_ORIGINS).default("FACULTY"),
  topics: z.array(z.enum(TOPICS)).max(4, "Give at most four topics.").default([]),
});
export type CreateProblemInput = z.input<typeof createProblemSchema>;

const draftRef = { versionId: idSchema, expectedEditSeq: editSeqSchema };

export const updateDetailsSchema = z.object({
  ...draftRef,
  title: titleSchema,
  difficulty: z.enum(DIFFICULTIES),
  statementMd: statementSchema,
  constraints: z.array(z.string().trim().min(1).max(300)).max(30, "At most 30 constraint lines.").default([]),
  origin: z.enum(CONTENT_ORIGINS),
});

export const updateJudgingSchema = z
  .object({
    ...draftRef,
    ioMode: z.enum(IO_MODES),
    functionSignature: signatureJsonSchema,
    /**
     * A SQL version's comparator is not the author's to choose — it
     * compares result sets — so the form still sends one of the four
     * authorable modes and the server ignores it for SQL. Offering ROWS
     * here would be offering it on a STDIN problem, which the database
     * refuses anyway.
     */
    compareMode: z.enum(AUTHORABLE_COMPARE_MODES, { errorMap: () => ({ message: "Choose a comparator: every problem declares one." }) }),
    floatEpsilon: z.coerce.number().positive("The tolerance is greater than 0.").max(1, "The tolerance is at most 1.").nullable(),
    scoringMode: z.enum(SCORING_MODES),
    stopOnFirstFailure: z.boolean(),
    timeLimitMs: timeLimitSchema,
    memoryLimitMb: memoryLimitMbSchema,
    /** SQL versions only (Phase 12k). */
    sqlOrdered: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.ioMode === "SQL" && v.sqlOrdered === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sqlOrdered"],
        message: "Say whether the row order is part of the answer.",
      });
    }
  });

export const checkerSchema = z.object({
  ...draftRef,
  source: z
    .string()
    .max(IMPORT_LIMITS.checkerBytes, "The checker is at most 256 KB.")
    .refine(noNul, "The checker contains a NUL character.")
    .nullable(),
});

const testText = z.string().refine(noNul, "Test data typed here cannot contain NUL; upload binary tests in an import package.");

/** The test-upload action is capped at 1 MB (the server-action body default); larger sets go through import. */
export const MAX_TEST_UPLOAD_BYTES = 900 * 1024;

export const addTestsSchema = z
  .object({
    ...draftRef,
    tests: z
      .array(
        z.object({
          input: testText,
          output: testText,
          isSample: z.boolean().default(false),
          subtaskIndex: z.number().int().min(1).max(100).nullable().default(null),
          points: z.number().int().positive().max(1000).nullable().default(null),
        }),
      )
      .min(1, "Add at least one test.")
      .max(100, "Add at most 100 tests at a time; use an import package for more."),
  })
  .refine(
    (v) => v.tests.reduce((sum, t) => sum + utf8Bytes(t.input) + utf8Bytes(t.output), 0) <= MAX_TEST_UPLOAD_BYTES,
    "Tests added here are limited to 900 KB in total; use an import package for larger tests.",
  );

export const updateTestSchema = z.object({
  ...draftRef,
  index: z.number().int().min(0),
  isSample: z.boolean(),
  subtaskIndex: z.number().int().min(1).max(100).nullable(),
  points: z.number().int().positive().max(1000).nullable(),
});

export const removeTestsSchema = z.object({
  ...draftRef,
  indexes: z.array(z.number().int().min(0)).min(1).max(IMPORT_LIMITS.tests),
});

export const subtasksSchema = z.object({
  ...draftRef,
  subtasks: z
    .array(
      z.object({
        index: z.number().int().min(1).max(100),
        points: z.number().positive().max(1000),
        aggregation: z.enum(SUBTASK_AGGREGATIONS).default("MIN"),
        dependsOn: z.array(z.number().int().min(1).max(100)).max(100).default([]),
      }),
    )
    .max(100),
});

const sourceText = z
  .string()
  .min(1, "Paste the source code.")
  .max(LIMITS.source.defaultBytes, "Source code is at most 256 KB.")
  .refine(noNul, "The source contains a NUL character.")
  .refine((s) => utf8Bytes(s) <= LIMITS.source.defaultBytes, "Source code is at most 256 KB.");

export const referenceSolutionSchema = z.object({
  ...draftRef,
  /** Present to edit an existing reference solution; absent to add one. */
  referenceId: idSchema.optional(),
  /**
   * Phase 12k: a SQL problem's model solution is its reference QUERY, in
   * the one language it can be written in. Everything else about a
   * reference solution — the label, the expected verdict, the optimistic
   * concurrency — is the same.
   */
  language: z.enum([...LANGUAGE_KEYS, SQL_LANGUAGE_KEY] as [string, ...string[]], {
    errorMap: () => ({ message: "Choose a language." }),
  }),
  label: z.string().trim().min(1, "Give the solution a label (e.g. Model, Brute force).").max(80),
  expectedVerdict: z.enum(REFERENCE_EXPECTED_VERDICTS, { errorMap: () => ({ message: "Choose the expected verdict." }) }),
  source: sourceText,
});

export const removeReferenceSchema = z.object({ ...draftRef, referenceId: idSchema });

export const starterSchema = z.object({
  ...draftRef,
  language: z.enum(LANGUAGE_KEYS),
  code: sourceText,
});

export const removeStarterSchema = z.object({ ...draftRef, language: z.enum(LANGUAGE_KEYS) });

const helpText = (max: number, what: string) =>
  z
    .string()
    .max(max, `${what} is too long.`)
    .refine(noNul, `${what} contains a NUL character.`)
    .refine((s) => utf8Bytes(s) <= max, `${what} is too long.`);

export const helpSchema = z.object({
  ...draftRef,
  /** Tiers 1..3 in order; an empty string removes that tier and every later one. */
  hints: z.array(helpText(IMPORT_LIMITS.hintBytes, "A hint")).max(3),
  editorialMd: helpText(IMPORT_LIMITS.editorialBytes, "The editorial").nullable(),
});

export const versionIdSchema = z.object({ versionId: idSchema });
export const problemIdSchema = z.object({ problemId: idSchema });

export const topicsSchema = z.object({
  problemId: idSchema,
  topics: z.array(z.enum(TOPICS)).min(1, "Choose at least one topic.").max(4, "Choose at most four topics."),
});

export const submitSchema = z.object({
  versionId: idSchema,
  expectedEditSeq: editSeqSchema,
  attestOriginal: z.literal(true, {
    errorMap: () => ({ message: "Confirm that the content is originally authored before submitting it for review." }),
  }),
  comment: z.string().trim().max(1000).optional(),
});

export const commentSchema = z.string().trim().max(1000);

export const returnSchema = z.object({
  versionId: idSchema,
  comment: z.string().trim().min(5, "Tell the author what to change (at least 5 characters).").max(1000),
});

export const reasonSchema = z
  .string()
  .trim()
  .min(5, "Give a reason of at least 5 characters — it is recorded in the audit log.")
  .max(500, "Keep the reason under 500 characters.");

export const publishSchema = z.object({
  versionId: idSchema,
  expectedProblemVersion: z.number({ required_error: "Reload the page: the form is missing the problem version." }).int().min(0),
});

export const previewSchema = z.object({ markdown: statementSchema });
