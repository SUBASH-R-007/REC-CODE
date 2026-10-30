import "server-only";
import { createHash } from "node:crypto";
import { LIMITS, functionSignatureSchema, type LanguageKey } from "@recx/shared";
import {
  HINT_FILE_PATTERN,
  IMPORT_LIMITS,
  PACKAGE_FILES,
  TEST_FILE_PATTERN,
  problemPackageMetaSchema,
  versionContentIssues,
  type ProblemPackageMeta,
  type ReferenceExpectedVerdict,
} from "@recx/shared/authoring";
import { validateFunctionTest } from "@recx/shared/harness";

/**
 * Parse one problem directory of an import package (format 1, see
 * docs/AUTHORING.md and @recx/shared/authoring/package.ts). Pure apart from
 * hashing: no database, no store. Every problem in the entry is collected
 * (not only the first), each with the file it is about, so an author can fix
 * a package in one pass.
 */

export type PackageFiles = ReadonlyMap<string, Buffer>;

export interface PackageIssue {
  path: string;
  message: string;
}

export interface PackageTest {
  index: number;
  isSample: boolean;
  subtaskIndex: number | null;
  points: number | null;
  input: Buffer;
  output: Buffer;
}

export interface ProblemPackage {
  meta: ProblemPackageMeta;
  statement: string;
  editorial: string | null;
  hints: string[];
  checker: string | null;
  /** INTERACTIVE problems (Phase 12l): the interactor's source. */
  interactor: string | null;
  tests: PackageTest[];
  solutions: { file: string; language: LanguageKey; expected: ReferenceExpectedVerdict; label: string; source: string }[];
  starters: { language: LanguageKey; code: string }[];
}

export type ParsedPackage =
  | { ok: true; pkg: ProblemPackage; packageSha256: string; warnings: PackageIssue[] }
  | { ok: false; errors: PackageIssue[]; warnings: PackageIssue[] };

const MAX_ISSUES = 200;
const decoder = new TextDecoder("utf-8", { fatal: true });

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Strict UTF-8 text without NUL, or null. */
export function utf8Text(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

/** The bytes a TestBlob stores inline (the workspace shows only inline samples). */
function inlineable(bytes: Buffer): boolean {
  return bytes.byteLength <= LIMITS.inlineBlobBytes && utf8Text(bytes) !== null;
}

/** JSON with object keys sorted at every level, for a hash that ignores formatting. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * sha256 of the package's canonical form: the parsed meta (sorted keys) and
 * every file's [path, sha256], sorted. Zip metadata (timestamps, order,
 * compression) does not change it, so re-uploading the same content is
 * recognised as UNCHANGED.
 */
export function packageSha256(meta: ProblemPackageMeta, files: PackageFiles): string {
  const list = [...files.entries()]
    .filter(([path]) => path !== PACKAGE_FILES.meta)
    .map(([path, bytes]) => [path, sha256(bytes)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256(canonicalJson({ meta, files: list }));
}

export function parseProblemPackage(entry: string, files: PackageFiles): ParsedPackage {
  const errors: PackageIssue[] = [];
  const warnings: PackageIssue[] = [];
  const error = (path: string, message: string) => {
    if (errors.length < MAX_ISSUES) errors.push({ path, message });
  };
  const warning = (path: string, message: string) => {
    if (warnings.length < MAX_ISSUES) warnings.push({ path, message });
  };
  const used = new Set<string>();

  const text = (path: string, maxBytes: number, required: boolean): string | null => {
    const bytes = files.get(path);
    if (!bytes) {
      if (required) error(path, "This file is missing.");
      return null;
    }
    used.add(path);
    if (bytes.byteLength > maxBytes) {
      error(path, `This file is ${bytes.byteLength} bytes; the limit is ${maxBytes}.`);
      return null;
    }
    const value = utf8Text(bytes);
    if (value === null) error(path, "This file is not UTF-8 text (or contains a NUL byte).");
    return value;
  };

  // meta.json
  let meta: ProblemPackageMeta | null = null;
  const metaText = text(PACKAGE_FILES.meta, 256 * 1024, true);
  if (metaText !== null) {
    let raw: unknown;
    try {
      raw = JSON.parse(metaText);
    } catch (e) {
      error(PACKAGE_FILES.meta, `Not valid JSON: ${(e as Error).message}`);
    }
    if (raw !== undefined) {
      const parsed = problemPackageMetaSchema.safeParse(raw);
      if (parsed.success) meta = parsed.data;
      else {
        for (const issue of parsed.error.issues) {
          const where = issue.path.length ? `${issue.path.join(".")}: ` : "";
          error(PACKAGE_FILES.meta, `${where}${issue.message}`);
        }
      }
    }
  }
  if (meta && meta.slug !== entry) warning(PACKAGE_FILES.meta, `The slug "${meta.slug}" differs from the directory name "${entry}"; the slug is used.`);

  const statement = text(PACKAGE_FILES.statement, IMPORT_LIMITS.statementBytes, true);
  if (statement !== null && statement.trim().length === 0) error(PACKAGE_FILES.statement, "The statement is empty.");
  const editorial = text(PACKAGE_FILES.editorial, IMPORT_LIMITS.editorialBytes, false);

  const hintFiles = new Map<number, string>();
  for (const path of files.keys()) {
    const m = HINT_FILE_PATTERN.exec(path);
    if (!m) continue;
    const value = text(path, IMPORT_LIMITS.hintBytes, true);
    if (value !== null) hintFiles.set(Number(m[1]), value);
  }
  const hints: string[] = [];
  for (let tier = 1; tier <= 3; tier++) {
    const h = hintFiles.get(tier);
    if (h === undefined) break;
    hints.push(h);
  }
  if (hints.length !== hintFiles.size) error(PACKAGE_FILES.hintsDir, "Hints must be hints/1.md, then 2.md, then 3.md, without gaps.");

  // testcases/NNN.in + NNN.out
  const ins = new Map<number, Buffer>();
  const outs = new Map<number, Buffer>();
  for (const [path, bytes] of files) {
    const m = TEST_FILE_PATTERN.exec(path);
    if (!m) {
      if (path.startsWith(`${PACKAGE_FILES.testsDir}/`)) error(path, "Test files are named testcases/NNN.in and testcases/NNN.out (three digits).");
      continue;
    }
    used.add(path);
    (m[2] === "in" ? ins : outs).set(Number(m[1]), bytes);
  }
  const indexes = [...new Set([...ins.keys(), ...outs.keys()])].sort((a, b) => a - b);
  for (const i of indexes) {
    const name = `${PACKAGE_FILES.testsDir}/${String(i).padStart(3, "0")}`;
    if (!ins.has(i)) error(`${name}.in`, `The input of test ${i} is missing (its .out exists).`);
    if (!outs.has(i)) error(`${name}.out`, `The expected output of test ${i} is missing (its .in exists).`);
  }
  if (indexes.length === 0) error(PACKAGE_FILES.testsDir, "There are no tests.");
  if (indexes.length > IMPORT_LIMITS.tests) error(PACKAGE_FILES.testsDir, `At most ${IMPORT_LIMITS.tests} tests.`);
  if (indexes.some((index, i) => index !== i)) error(PACKAGE_FILES.testsDir, "Tests must be numbered 000, 001, 002, … without gaps.");
  const testCount = indexes.length;

  const tests: PackageTest[] = [];
  if (meta) {
    const samples = new Set(meta.samples);
    for (const s of samples) if (s >= testCount) error(PACKAGE_FILES.meta, `samples: test ${s} does not exist.`);
    const subtaskOf = new Map<number, number>();
    for (const s of meta.subtasks) for (const t of s.tests) subtaskOf.set(t, s.index);
    if (meta.scoringMode === "SUBTASK") {
      for (const t of subtaskOf.keys()) if (t >= testCount) error(PACKAGE_FILES.meta, `subtasks: test ${t} does not exist.`);
      for (let i = 0; i < testCount; i++) if (!subtaskOf.has(i)) error(PACKAGE_FILES.meta, `subtasks: test ${i} belongs to no subtask.`);
    }
    for (const key of Object.keys(meta.points ?? {})) {
      if (Number(key) >= testCount) error(PACKAGE_FILES.meta, `points: test ${key} does not exist.`);
    }
    const signature = meta.ioMode === "FUNCTION" ? functionSignatureSchema.safeParse(meta.functionSignature) : null;
    let functionIssues = 0;
    for (let i = 0; i < testCount; i++) {
      const input = ins.get(i);
      const output = outs.get(i);
      if (!input || !output) continue;
      const name = `${PACKAGE_FILES.testsDir}/${String(i).padStart(3, "0")}`;
      if (input.byteLength > IMPORT_LIMITS.fileBytes) error(`${name}.in`, `Larger than ${IMPORT_LIMITS.fileBytes / 1024 / 1024} MB.`);
      if (output.byteLength > IMPORT_LIMITS.fileBytes) error(`${name}.out`, `Larger than ${IMPORT_LIMITS.fileBytes / 1024 / 1024} MB.`);
      const isSample = samples.has(i);
      if (isSample && !(inlineable(input) && inlineable(output))) {
        error(`${name}.in`, `Sample test ${i} must be UTF-8 text of at most ${LIMITS.inlineBlobBytes / 1024} KB per file (students see samples).`);
      }
      if (signature?.success && functionIssues < 20) {
        const inText = utf8Text(input);
        const outText = utf8Text(output);
        const issues = inText === null || outText === null ? ["A FUNCTION test is UTF-8 text."] : validateFunctionTest(signature.data, inText, outText);
        for (const message of issues.slice(0, 3)) {
          error(`${name}.in`, `Test ${i}: ${message}`);
          functionIssues++;
        }
      }
      tests.push({
        index: i,
        isSample,
        subtaskIndex: subtaskOf.get(i) ?? null,
        points: meta.points?.[String(i)] ?? null,
        input,
        output,
      });
    }
  }

  // Reference solutions, starters, checker.
  const solutions: ProblemPackage["solutions"] = [];
  const starters: ProblemPackage["starters"] = [];
  let checker: string | null = null;
  let interactor: string | null = null;
  if (meta) {
    for (const s of meta.solutions) {
      const source = text(s.file, IMPORT_LIMITS.sourceBytes, true);
      if (source !== null) solutions.push({ file: s.file, language: s.language, expected: s.expected, label: s.label, source });
    }
    for (const [language, path] of Object.entries(meta.starters) as [LanguageKey, string][]) {
      const code = text(path, IMPORT_LIMITS.sourceBytes, true);
      if (code !== null) starters.push({ language, code });
    }
    if (meta.checker !== null) checker = text(meta.checker, IMPORT_LIMITS.checkerBytes, true);
    if (meta.interactor !== null) interactor = text(meta.interactor, IMPORT_LIMITS.checkerBytes, true);
  }
  for (const path of files.keys()) {
    if (!used.has(path)) warning(path, "Not part of the package format; ignored.");
  }

  if (meta && statement !== null) {
    const issues = versionContentIssues({
      ioMode: meta.ioMode,
      compareMode: meta.compareMode,
      floatEpsilon: meta.floatEpsilon,
      functionSignature: meta.functionSignature,
      checkerSha256: checker !== null ? sha256(checker) : null,
      interactorSha256: interactor !== null ? sha256(interactor) : null,
      testlibId: checker !== null || interactor !== null ? "testlib" : null,
      scoringMode: meta.scoringMode,
      timeLimitMs: meta.timeLimitMs,
      memoryLimitKb: meta.memoryLimitKb,
      statementMd: statement,
      tests: tests.map((t) => ({
        index: t.index,
        isSample: t.isSample,
        subtaskIndex: t.subtaskIndex,
        points: t.points,
        inputBytes: t.input.byteLength,
        outputBytes: t.output.byteLength,
        sampleInlineable: inlineable(t.input) && inlineable(t.output),
      })),
      subtasks: meta.subtasks,
      references: solutions.map((s) => ({ language: s.language, expectedVerdict: s.expected })),
    });
    for (const issue of issues) {
      // Duplicates of the per-file checks above are skipped.
      if (issue.code === "SAMPLE_NOT_INLINE" || issue.code === "STATEMENT_EMPTY" || issue.code === "TEST_INDEX_GAP") continue;
      (issue.severity === "error" ? error : warning)(PACKAGE_FILES.meta, issue.message);
    }
  }

  if (errors.length > 0 || !meta || statement === null) {
    return { ok: false, errors: errors.length > 0 ? errors : [{ path: entry, message: "The package is incomplete." }], warnings };
  }
  return {
    ok: true,
    pkg: { meta, statement, editorial, hints, checker, interactor, tests, solutions, starters },
    packageSha256: packageSha256(meta, files),
    warnings,
  };
}
