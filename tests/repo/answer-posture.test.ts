import { describe, expect, it } from "vitest";
import { CODE_EXTENSIONS, findFiles, isTestPath, readRepoFile } from "./support/repo";

/**
 * Output-only problems, as rules a test can hold true (Phase 12n).
 *
 *   1. **The verdict comes from the fleet.** A text comparison needs no
 *      sandbox, which makes it tempting to do in the web process — and a
 *      CHECKER answer-problem runs the AUTHOR's program, which may only
 *      ever run in a box. So the comparison lives in the worker, and the
 *      web app compares nothing.
 *   2. **No program means no runtime.** `language` is null exactly for an
 *      output-only job, both halves asserted by the protocol itself.
 *   3. **`answer1` is a language a submission carries, not a toolchain.**
 *      It is never in `LANGUAGE_KEYS`, and the judge never compiles it.
 *   4. **One visible case.** Said by the spec builder and by the worker.
 */

const SHARED = "packages/shared/src/answer-problem.ts";
const WORKER = "apps/judge-worker/src";
const WORKSPACE = "apps/web/src/components/workspace";
const webSources = findFiles({ under: ["apps/web/src"], extensions: [...CODE_EXTENSIONS] }).filter((f) => !isTestPath(f));

describe("the comparison belongs to the judge", () => {
  it("the worker has the answer path, and it compares there", () => {
    const answer = readRepoFile(`${WORKER}/judge/answer.ts`);
    expect(answer).toContain("compareOutputs");
    expect(answer).toContain("CheckerRunner");
    // No run box: the only role an answer job may init is the checker's.
    expect(answer).not.toContain('sandbox.init("run")');
    expect(answer).not.toContain('sandbox.init("compile")');
  });

  it("the web app compares no output of its own, for an answer or anything else", () => {
    for (const file of webSources) {
      const source = readRepoFile(file);
      expect(source, `${file} must not compare output itself`).not.toContain("compareOutputs(");
    }
  });

  it("and spawns no process, as ever", () => {
    for (const file of webSources) {
      expect(readRepoFile(file), `${file} must not spawn a process`).not.toContain("child_process");
    }
  });
});

describe("no program means no runtime", () => {
  it("the protocol says null exactly for an output-only job", () => {
    const protocol = readRepoFile("packages/shared/src/protocol.ts");
    expect(protocol).toContain("language: languageRuntimeSchema.nullable()");
    expect(protocol).toMatch(/const answerOnly = spec\.ioMode === "OUTPUT_ONLY"/);
    expect(protocol).toContain("JUDGE_PROTOCOL_VERSION = 6");
  });

  it("the worker asks for a runtime through one function, which refuses null", () => {
    const plan = readRepoFile(`${WORKER}/judge/plan.ts`);
    expect(plan).toContain("export function requireRuntime");
    for (const file of findFiles({ under: [`${WORKER}/judge`, `${WORKER}/drivers`], extensions: [".ts"] })) {
      const source = readRepoFile(file);
      // Every unguarded `spec.language.` is a crash waiting for an answer job.
      expect(source, `${file} must not read spec.language without a guard`).not.toMatch(/\bspec\.language\.[a-z]/);
    }
  });

  it("the mock driver refuses to fabricate an answer verdict", () => {
    expect(readRepoFile(`${WORKER}/drivers/mock.ts`)).toContain("the submission is the answer itself");
  });
});

describe("answer1 is not a toolchain", () => {
  it("it is in the submit list and not in the language catalogue", () => {
    const submit = readRepoFile("packages/shared/src/submit-language.ts");
    expect(submit).toContain("ANSWER_LANGUAGE_KEY");
    const languages = readRepoFile("packages/shared/src/languages.ts");
    expect(languages).not.toContain("answer1");
  });

  it("its runtime is nothing like a LanguageRuntime", () => {
    const shared = readRepoFile(SHARED);
    expect(shared).toContain("answerRuntimeSchema");
    // The SCHEMA, not the prose around it: the comment explains what an
    // answer runtime does not have, and naming a field is not carrying one.
    const schema = /answerRuntimeSchema = z[\s\S]*?\.strict\(\);/.exec(shared)?.[0] ?? "";
    expect(schema).toContain("key: z.literal(ANSWER_LANGUAGE_KEY)");
    for (const field of ["argv", "toolchainId", "sourceFile", "processes", "compile", "run"]) {
      expect(schema, `an answer runtime has no ${field}`).not.toContain(field);
    }
  });

  it("the database says what an output-only version is not", () => {
    const migration = readRepoFile(
      "packages/db/prisma/migrations/20261101160500_phase12n_output_only_checks/migration.sql",
    );
    expect(migration).toContain("ProblemVersion_output_only_fields");
    for (const column of ["functionSignature", "sqlDialect", "interactorSha256", "maxEditedLines"]) {
      expect(migration, column).toContain(column);
    }
    expect(readRepoFile("packages/db/test/support/guard-catalog.ts")).toContain("ProblemVersion_output_only_fields");
  });

  it("the enum value is added by a migration of its own, because PostgreSQL requires it", () => {
    const mode = readRepoFile("packages/db/prisma/migrations/20261101160000_phase12n_output_only_mode/migration.sql");
    expect(mode).toContain("ADD VALUE 'OUTPUT_ONLY'");
    // Nothing else may be in that migration: a new enum value cannot be
    // used in the transaction that adds it.
    expect(mode).not.toMatch(/ADD CONSTRAINT|CREATE TRIGGER|UPDATE /i);
  });
});

describe("one visible case, and nothing to run", () => {
  it("the spec builder refuses any other shape", () => {
    const builder = readRepoFile("apps/web/src/lib/judge/answer-job-spec.ts");
    expect(builder).toContain("exactly one case");
    expect(builder).toContain("must be visible");
    expect(builder).toContain("nothing to run");
  });

  it("and the submit action refuses a Run with the sentence from @recx/shared", () => {
    const action = readRepoFile("apps/web/src/server/actions/judge.ts");
    expect(action).toContain("ANSWER_REFUSALS.noRun");
  });

  it("the publish gate asks for one visible case and the model answer", () => {
    const content = readRepoFile("packages/shared/src/authoring/content.ts");
    for (const code of ["ANSWER_ONE_CASE", "ANSWER_HIDDEN_CASE", "ANSWER_NO_EXPECTED", "ANSWER_NO_REFERENCE"]) {
      expect(content, code).toContain(code);
    }
    // And lifts the two rules that do not apply to this kind.
    expect(content).toMatch(/ioMode !== "OUTPUT_ONLY" && v\.tests\.every/);
    expect(content).toMatch(/v\.ioMode !== "SQL" && v\.ioMode !== "OUTPUT_ONLY"/);
  });

  it("the model answer is a reference solution in the one language an answer is written in", () => {
    const content = readRepoFile("packages/shared/src/authoring/content.ts");
    expect(content).toContain('export const ANSWER_REFERENCE_LANGUAGE = "answer1"');
    // Validation has to be able to see that language, or nothing publishes.
    expect(readRepoFile("apps/web/src/lib/judge/validation.ts")).toContain("ANSWER_LANGUAGE_KEY");
  });

  it("the expected answer is withheld where it is read, not where it is rendered", () => {
    // The one case of an output-only problem is a SAMPLE, because its data
    // is the question — and on every other kind "sample" means the student
    // sees the expected output too. Here that would be the answer, so both
    // reads drop it before it can reach a page.
    const query = readRepoFile("apps/web/src/server/queries/problems.ts");
    expect(query).toMatch(/version\.ioMode === "OUTPUT_ONLY" \? "" :/);
    const finalize = readRepoFile("apps/web/src/lib/judge/finalize.ts");
    expect(finalize).toMatch(/ioMode === "OUTPUT_ONLY"/);
    // And the console renders no expected block for one either.
    const console_ = readRepoFile(`${WORKSPACE}/result-view.tsx`);
    expect(console_).toContain("!answer &&");
    expect(console_).toMatch(/view\.ioMode === "OUTPUT_ONLY"/);
  });

  it("there is no Run button for a question that runs nothing", () => {
    const workspace = readRepoFile(`${WORKSPACE}/workspace.tsx`);
    expect(workspace).toContain("{!answerOnly && (");
    expect(workspace).toContain("isAnswerLanguage(active.key)");
  });

  it("reach the editor and the Description tab from that one module", () => {
    expect(readRepoFile(`${WORKSPACE}/answer-note.tsx`)).toContain("ANSWER_NOTICES");
    const description = readRepoFile(`${WORKSPACE}/problem-description.tsx`);
    for (const key of ["whatToSubmit", "noProgram", "oneCase", "whitespace"]) {
      expect(description, `the Description tab must state ANSWER_NOTICES.${key}`).toContain(`ANSWER_NOTICES.${key}`);
    }
  });

  it("the sentences a student reads are defined once", () => {
    const shared = readRepoFile(SHARED);
    expect(shared).toContain("export const ANSWER_NOTICES");
    expect(shared).toContain("export const ANSWER_REFUSALS");
    expect(shared).toContain("export const ANSWER_LABELS");
    for (const file of webSources) {
      expect(readRepoFile(file), `${file} must take the sentence from ANSWER_NOTICES`).not.toContain(
        "not a program. Work out the answer",
      );
    }
  });
});

describe("not sat in an assessment yet, and not quietly", () => {
  it("a trigger refuses the pin, because a sitting has one editor for every question", () => {
    const migration = readRepoFile(
      "packages/db/prisma/migrations/20261101161000_phase12n_assessment_rule/migration.sql",
    );
    expect(migration).toContain("AssessmentProblem_no_output_only");
    expect(migration).toContain("not sat in an assessment yet");
    expect(migration).toMatch(/CREATE TRIGGER[\s\S]*ON "public"\."AssessmentProblem"/);
    // A contest links to the ordinary workspace, so it needs no rule.
    expect(migration).not.toMatch(/ON "public"\."ContestProblem"/);
  });

  it("the action says so in a sentence first", () => {
    const action = readRepoFile("apps/web/src/server/actions/admin-assessments.ts");
    expect(action).toContain("An output-only problem is not sat in an assessment yet");
  });

  it("the trigger and its function are catalogued, so lifting the rule fails the build", () => {
    const catalog = readRepoFile("packages/db/test/support/guard-catalog.ts");
    expect(catalog).toContain("AssessmentProblem_no_output_only");
    expect(catalog).toContain("recx_refuse_output_only_assessment_problem");
  });
});
