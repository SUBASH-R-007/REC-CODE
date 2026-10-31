import { z } from "zod";
import { ANSWER_LANGUAGE_KEY } from "../answer-problem";
import { DEBUG_BUDGET } from "../debug-problem";
import { SQL_LANGUAGE_KEY } from "../sql-language";
import { deepFreeze } from "../freeze";
import { FUNCTION_COMPARATORS, functionSignatureSchema } from "../harness/signature";
import { LANGUAGE_KEYS } from "../languages";
import { LIMITS } from "../limits";
import { SCORING_MODES, SUBTASK_AGGREGATIONS, IO_MODES } from "../protocol";
import { TOPICS } from "../topics";
import { AUTHORABLE_COMPARE_MODES, MIN_MEMORY_LIMIT_KB, REFERENCE_EXPECTED_VERDICTS } from "./content";
import { CONTENT_ORIGINS_LIST } from "./origins";

/**
 * Bulk-import package, format 1: one directory per problem.
 *
 *   <slug>/meta.json          problemPackageMetaSchema (strict)
 *   <slug>/statement.md       the statement (Markdown, UTF-8)
 *   <slug>/editorial.md       optional editorial
 *   <slug>/hints/1.md … 3.md  optional tiered hints
 *   <slug>/checker.cpp        CHECKER / CUSTOM_CHECKER only: a testlib checker
 *   <slug>/interactor.cpp     INTERACTIVE only (Phase 12l): a testlib
 *                             interactor. Its cases still come in pairs,
 *                             with EMPTY .out files — an interactive
 *                             problem compares no output, and the pairing
 *                             is what keeps the format one format.
 *   <slug>/testcases/000.in   tests, paired .in/.out, contiguous from 000
 *   <slug>/testcases/000.out
 *   <slug>/solutions/…        reference solutions named in meta.solutions
 *   <slug>/starters/…         starter code named in meta.starters
 *
 * Pure: zod schemas and constants only. Parsing a package (hashing, UTF-8
 * checks, pairing tests) lives in apps/web/src/lib/authoring/import.
 */

export const PROBLEM_PACKAGE_FORMAT = 1;

export const PACKAGE_FILES = {
  meta: "meta.json",
  statement: "statement.md",
  editorial: "editorial.md",
  checker: "checker.cpp",
  interactor: "interactor.cpp",
  testsDir: "testcases",
  solutionsDir: "solutions",
  startersDir: "starters",
  hintsDir: "hints",
} as const;

/** testcases/NNN.in | testcases/NNN.out (three digits, contiguous from 000). */
export const TEST_FILE_PATTERN = /^testcases\/(\d{3})\.(in|out)$/;
/** hints/1.md, hints/2.md, hints/3.md */
export const HINT_FILE_PATTERN = /^hints\/([123])\.md$/;

/** Hard caps for one import (the UI upload and the CLI share them). */
export const IMPORT_LIMITS = deepFreeze({
  /** The uploaded archive itself. */
  archiveBytes: 256 * 1024 * 1024,
  /** Problem directories per archive. */
  entries: 500,
  /** Files in the whole archive. */
  archiveFiles: 50_000,
  /** Files in one problem directory (1,000 tests × 2 + the rest). */
  filesPerEntry: 2_100,
  /** One file, inflated. Larger test files need a streaming store put. */
  fileBytes: 64 * 1024 * 1024,
  /** One problem directory, inflated. */
  entryBytes: 512 * 1024 * 1024,
  /** The whole archive, inflated (zip-bomb fence). */
  totalUncompressedBytes: 4 * 1024 ** 3,
  tests: 1_000,
  statementBytes: 64 * 1024,
  editorialBytes: 64 * 1024,
  hintBytes: 8 * 1024,
  checkerBytes: 256 * 1024,
  /** A reference solution or starter file. */
  sourceBytes: LIMITS.source.defaultBytes,
  /** Characters in one archive path. */
  pathChars: 200,
});

export const problemSlugSchema = z
  .string()
  .trim()
  .min(1, "The slug is required.")
  .max(100, "The slug is at most 100 characters.")
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lower-case letters, digits and single hyphens (e.g. loud-echo).");

export const displayCodeSchema = z
  .string()
  .trim()
  .regex(/^REC-\d{4}$/, "The display code is REC- followed by four digits (e.g. REC-0101).");

/** A relative, "/"-separated path inside a package: no "..", no leading "/", no "\\", no NUL. */
export const packagePathSchema = z
  .string()
  .min(1)
  .max(IMPORT_LIMITS.pathChars)
  .refine((p) => !p.includes("\\") && !p.includes("\u0000"), "Paths use / and contain no NUL.")
  .refine((p) => !p.startsWith("/") && !/^[A-Za-z]:/.test(p), "Paths are relative.")
  .refine((p) => p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== ".."), "Paths contain no empty, . or .. segments.");

const intIn = (min: number, max: number, what: string) =>
  z
    .number({ invalid_type_error: `${what} must be a number.` })
    .int(`${what} must be a whole number.`)
    .min(min, `${what} must be at least ${min}.`)
    .max(max, `${what} must be at most ${max}.`);

const testIndex = z.number().int().min(0).max(IMPORT_LIMITS.tests - 1);

const subtaskSchema = z
  .object({
    index: z.number().int().min(1).max(100),
    points: z.number().positive().max(1000),
    aggregation: z.enum(SUBTASK_AGGREGATIONS).default("MIN"),
    dependsOn: z.array(z.number().int().min(1)).max(100).default([]),
    tests: z.array(testIndex).min(1).max(IMPORT_LIMITS.tests),
  })
  .strict();

const solutionSchema = z
  .object({
    file: packagePathSchema.refine((p) => p.startsWith(`${PACKAGE_FILES.solutionsDir}/`), "Solutions live under solutions/."),
    /**
     * A toolchain, or one of the two languages that are not toolchains: a
     * SQL problem's model solution is its reference QUERY (Phase 12k) and
     * an output-only problem's is its model ANSWER (Phase 12n). The gate
     * asks for each by name, so a package that could not name them could
     * not describe either kind of problem.
     */
    language: z.enum([...LANGUAGE_KEYS, SQL_LANGUAGE_KEY, ANSWER_LANGUAGE_KEY] as [string, ...string[]]),
    expected: z.enum(REFERENCE_EXPECTED_VERDICTS),
    label: z.string().trim().min(1).max(80),
  })
  .strict();

const starterPath = packagePathSchema.refine(
  (p) => p.startsWith(`${PACKAGE_FILES.startersDir}/`),
  "Starter code lives under starters/.",
);

export const problemPackageMetaSchema = z
  .object({
    format: z.literal(PROBLEM_PACKAGE_FORMAT),
    slug: problemSlugSchema,
    displayCode: displayCodeSchema,
    title: z.string().trim().min(3, "The title is at least 3 characters.").max(120, "The title is at most 120 characters."),
    difficulty: z.enum(["EASY", "MEDIUM", "HARD"]),
    /** 1..4 topics, primary first. */
    topics: z.array(z.enum(TOPICS)).min(1, "Give at least one topic.").max(4, "Give at most four topics."),
    origin: z.enum(CONTENT_ORIGINS_LIST),
    constraints: z.array(z.string().trim().min(1).max(300)).max(30).default([]),
    ioMode: z.enum(IO_MODES),
    functionSignature: z.unknown().nullable().default(null),
    /** Required, no default: the declared comparator for STDIN problems. */
    compareMode: z.enum(AUTHORABLE_COMPARE_MODES, {
      errorMap: () => ({ message: `compareMode is required: one of ${AUTHORABLE_COMPARE_MODES.join(", ")}.` }),
    }),
    floatEpsilon: z.number().positive().max(1).nullable().default(null),
    scoringMode: z.enum(SCORING_MODES).default("ICPC"),
    stopOnFirstFailure: z.boolean().default(true),
    /** The "no problem over 15 s" rule. */
    timeLimitMs: intIn(LIMITS.cpuTime.floorMs, LIMITS.cpuTime.ceilingMs, "timeLimitMs"),
    /** The "no problem over 1 GB" rule. */
    memoryLimitKb: intIn(MIN_MEMORY_LIMIT_KB, LIMITS.memory.ceilingKb, "memoryLimitKb").default(LIMITS.memory.defaultKb),
    /** Indexes of the sample tests. */
    samples: z.array(testIndex).min(1, "List at least one sample test.").max(IMPORT_LIMITS.tests),
    /** PER_TEST scoring: points per test index ("3": 10); a test without points weighs 1. */
    points: z.record(z.string().regex(/^\d{1,3}$/), z.number().int().positive().max(1000)).optional(),
    subtasks: z.array(subtaskSchema).max(100).default([]),
    solutions: z.array(solutionSchema).min(1, "List at least one reference solution.").max(30),
    starters: z.record(z.enum(LANGUAGE_KEYS), starterPath).default({}),
    checker: packagePathSchema.nullable().default(null),
    /** INTERACTIVE only (Phase 12l). */
    interactor: packagePathSchema.nullable().default(null),
    /**
     * DEBUGGING problems (Phase 12m): the most lines a student may change
     * in the starter. Null — the default — is every other problem, so an
     * existing package imports unchanged.
     */
    maxEditedLines: intIn(DEBUG_BUDGET.min, DEBUG_BUDGET.max, "maxEditedLines").nullable().default(null),
  })
  .strict()
  .superRefine((meta, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    const hasSignature = meta.functionSignature !== null && meta.functionSignature !== undefined;
    if ((meta.ioMode === "FUNCTION") !== hasSignature) {
      issue(["functionSignature"], meta.ioMode === "FUNCTION" ? "A FUNCTION problem needs a functionSignature." : "Only a FUNCTION problem has a functionSignature.");
    }
    let customChecker = false;
    if (meta.ioMode === "FUNCTION" && hasSignature) {
      const sig = functionSignatureSchema.safeParse(meta.functionSignature);
      if (!sig.success) {
        const first = sig.error.issues[0];
        const raw = meta.functionSignature as { comparator?: unknown } | null;
        const comparatorMissing = !raw || typeof raw !== "object" || raw.comparator === undefined;
        issue(
          ["functionSignature"],
          comparatorMissing
            ? `functionSignature.comparator is required: one of ${FUNCTION_COMPARATORS.join(", ")}.`
            : `functionSignature is invalid: ${first ? `${first.path.join(".") || "signature"}: ${first.message}` : "unknown error"}`,
        );
      } else customChecker = sig.data.comparator === "CUSTOM_CHECKER";
    }
    const needsChecker = meta.compareMode === "CHECKER" || customChecker;
    if (needsChecker && meta.checker === null) issue(["checker"], "A checker problem needs checker.cpp (meta.checker).");
    if (!needsChecker && meta.checker !== null) issue(["checker"], "A checker is given but the compare mode is not CHECKER.");
    /**
     * Phase 12l. The interactor is the same kind of artefact as the
     * checker and obeys the same two rules, in both directions: an
     * interactive problem has one, and nothing else does.
     */
    const interactive = meta.compareMode === "INTERACTIVE";
    if (interactive && meta.interactor === null) {
      issue(["interactor"], "An interactive problem needs interactor.cpp (meta.interactor).");
    }
    if (!interactive && meta.interactor !== null) {
      issue(["interactor"], "An interactor is given but the compare mode is not INTERACTIVE.");
    }
    if (interactive && meta.ioMode !== "STDIN") {
      issue(["compareMode"], "An interactive problem reads and writes on standard input and output.");
    }
    if (interactive && meta.floatEpsilon !== null) {
      issue(["floatEpsilon"], "An interactive problem compares no output, so floatEpsilon would change nothing.");
    }
    if (meta.compareMode === "FLOAT" && meta.floatEpsilon === null) issue(["floatEpsilon"], "FLOAT comparison needs floatEpsilon.");
    /**
     * Phase 12m. A debugging problem's question is its starter: the broken
     * program, in the languages the problem is offered in. A budget with no
     * starter would import a problem the workspace could offer in no
     * language at all, and the publish gate would refuse it later — better
     * here, naming the file that is missing.
     */
    /**
     * Phase 12n. An output-only package describes one case and names its
     * model ANSWER; the publish gate says the rest (one case, visible,
     * with expected output stored). What is worth refusing HERE is the
     * pairing, because the whole package is built around it.
     */
    if (meta.ioMode === "OUTPUT_ONLY") {
      if (interactive) issue(["compareMode"], "An output-only problem compares the answer; a conversation is not a comparison for one.");
      if (meta.samples.length !== 1) issue(["samples"], "An output-only problem has exactly one case, and it is the sample.");
      if (Object.keys(meta.starters).length > 0) issue(["starters"], "An output-only problem has no starter: the editor opens empty.");
      if (!meta.solutions.some((s) => s.language === ANSWER_LANGUAGE_KEY && s.expected === "AC")) {
        issue(["solutions"], `An output-only problem needs its model answer: a solution in ${ANSWER_LANGUAGE_KEY} expected AC.`);
      }
    }
    if (meta.maxEditedLines !== null) {
      if (Object.keys(meta.starters).length === 0) {
        issue(["starters"], "A debugging problem (maxEditedLines) needs the broken program under starters/.");
      }
      if (meta.ioMode === "SQL" || interactive) {
        issue(["maxEditedLines"], "An edit budget belongs to a problem that hands the student a program to repair.");
      }
    }

    if ((meta.scoringMode === "SUBTASK") !== (meta.subtasks.length > 0)) {
      issue(["subtasks"], meta.scoringMode === "SUBTASK" ? "SUBTASK scoring needs subtasks." : "Subtasks are only used with SUBTASK scoring.");
    }
    if (meta.points && meta.scoringMode !== "PER_TEST") issue(["points"], "points are only used with PER_TEST scoring.");
    const seenSubtask = new Set<number>();
    const seenTest = new Set<number>();
    for (const [i, s] of meta.subtasks.entries()) {
      if (seenSubtask.has(s.index)) issue(["subtasks", i, "index"], `Subtask ${s.index} is listed twice.`);
      for (const dep of s.dependsOn) {
        if (dep >= s.index || !seenSubtask.has(dep)) issue(["subtasks", i, "dependsOn"], `Subtask ${s.index} may depend only on an earlier subtask.`);
      }
      seenSubtask.add(s.index);
      for (const t of s.tests) {
        if (seenTest.has(t)) issue(["subtasks", i, "tests"], `Test ${t} is in more than one subtask.`);
        seenTest.add(t);
      }
    }
    if (new Set(meta.samples).size !== meta.samples.length) issue(["samples"], "A sample index is listed twice.");
    const files = new Set<string>();
    for (const [i, s] of meta.solutions.entries()) {
      if (files.has(s.file)) issue(["solutions", i, "file"], `${s.file} is listed twice.`);
      files.add(s.file);
    }
  });

export type ProblemPackageMeta = z.infer<typeof problemPackageMetaSchema>;
