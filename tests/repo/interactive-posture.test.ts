import { describe, expect, it } from "vitest";
import { CODE_EXTENSIONS, findFiles, isTestPath, readRepoFile } from "./support/repo";

/**
 * Interactive problems, as rules a test can hold true (Phase 12l).
 *
 *   1. **Two boxes, and the student's program is in neither of the other
 *      two.** The solution runs in the RUN box and the interactor in the
 *      CHECKER box; nothing about an interactive case runs in the web
 *      process, as nothing about any case does.
 *   2. **The interactor is the author's, always.** It is compiled by the
 *      node from a blob the AUTHORING surface wrote, and no student input
 *      reaches that path.
 *   3. **One judge, not two.** The database refuses a version with both a
 *      checker and an interactor, and the job spec sends one or the other.
 *   4. **An interactive problem is not sat in an assessment yet**, which
 *      is SPEC §11's own rule with a date on it: a trigger, a sentence in
 *      the action, and a line in the guard catalogue so lifting it cannot
 *      be quiet.
 */

const WORKER = "apps/judge-worker/src";
const WORKSPACE = "apps/web/src/components/workspace";
const webSources = findFiles({ under: ["apps/web/src"], extensions: [...CODE_EXTENSIONS] }).filter((f) => !isTestPath(f));

describe("the conversation happens in two boxes", () => {
  it("the solution runs in the run box and the interactor in the checker box", () => {
    const interactive = readRepoFile(`${WORKER}/judge/interactive.ts`);
    expect(interactive).toContain('role: "run"');
    expect(interactive).toContain('role: "checker"');
    // A fresh box per case, exactly as a checker gets.
    expect(interactive).toContain('sandbox.init("checker")');
  });

  it("the pipes are the worker's: no shared directory between the boxes", () => {
    const isolate = readRepoFile(`${WORKER}/sandbox/isolate.ts`);
    // The one run in the judge with no --stdout: its stdout is a pipe.
    expect(isolate).toContain("stdout: null");
    // A FIFO pair would need a writable directory bound into both boxes.
    expect(isolate).not.toContain("mkfifo");
    for (const rule of isolate.matchAll(/--dir=([^"`\s]+)/g)) {
      expect(rule[1], "no new writable bind mount came with the pair").not.toMatch(/fifo|pipe/i);
    }
  });

  it("the deadlock deadline and the interactor's output cap are the shared limits", () => {
    const limits = readRepoFile("packages/shared/src/limits.ts");
    expect(limits).toMatch(/interactive: \{ idleMs: 2_000/);
    const interactive = readRepoFile(`${WORKER}/judge/interactive.ts`);
    expect(interactive).toContain("LIMITS.interactive.idleMs");
    expect(interactive).toContain("LIMITS.interactive.interactorOutputBytes");
  });
});

describe("no student code runs in the web process, interactive included", () => {
  it("the web app spawns no process, for an interactor or anything else", () => {
    // The authoring form DOES mention registerInteraction — in the help
    // text an author reads. Naming it is not running it; spawning is.
    for (const file of webSources) {
      expect(readRepoFile(file), `${file} must not spawn a process`).not.toContain("child_process");
    }
  });

  it("the interactor the node compiles comes from the version, not from a submission", () => {
    const claim = readRepoFile("apps/web/src/lib/judge/claim.ts");
    expect(claim).toContain("interactorSha256");
    // Resolved from the pinned version's own column, like the checker.
    expect(claim).toMatch(/version\.compareMode === "INTERACTIVE" && interactorSha256/);
  });
});

describe("one judge, not two", () => {
  it("the database refuses a version that carries both", () => {
    const migration = readRepoFile("packages/db/prisma/migrations/20261101140000_phase12l_interactive/migration.sql");
    expect(migration).toContain("ProblemVersion_interactive_no_checker");
    expect(migration).toContain("ProblemVersion_interactive_mode_mirror");
    expect(migration).toContain("ProblemVersion_interactive_stdin_only");
  });

  it("every one of those CHECKs is in the guard catalogue", () => {
    const catalog = readRepoFile("packages/db/test/support/guard-catalog.ts");
    for (const name of [
      "ProblemVersion_interactive_mode_mirror",
      "ProblemVersion_interactive_stdin_only",
      "ProblemVersion_interactive_no_checker",
      "ProblemVersion_interactive_no_epsilon",
    ]) {
      expect(catalog, name).toContain(name);
    }
  });
});

describe("the sentences a student reads", () => {
  it("are defined once, in @recx/shared", () => {
    const shared = readRepoFile("packages/shared/src/interactive.ts");
    expect(shared).toContain("export const INTERACTIVE_NOTICES");
    expect(shared).toContain("export const INTERACTIVE_REFUSALS");
    expect(shared).toContain("export const INTERACTIVE_LABELS");
  });

  it("are never retyped into a component", () => {
    // The flush sentence is the one every surface wants to say in its own
    // words; two copies is one copy that goes stale.
    for (const file of webSources) {
      const source = readRepoFile(file);
      expect(source, `${file} must take the flush sentence from INTERACTIVE_NOTICES`).not.toContain(
        "print(..., flush=True)",
      );
    }
  });

  it("reach the editor, the Description tab and the console from that one module", () => {
    expect(readRepoFile(`${WORKSPACE}/interactive-note.tsx`)).toContain("INTERACTIVE_NOTICES");
    const description = readRepoFile(`${WORKSPACE}/problem-description.tsx`);
    for (const key of ["dialogue", "flush", "deadlock", "sampleData", "transcript", "noCustomInput"]) {
      expect(description, `the Description tab must state INTERACTIVE_NOTICES.${key}`).toContain(
        `INTERACTIVE_NOTICES.${key}`,
      );
    }
    expect(readRepoFile(`${WORKSPACE}/result-view.tsx`)).toContain("INTERACTIVE_LABELS");
  });

  it("are what the submit boundary refuses with", () => {
    const action = readRepoFile("apps/web/src/server/actions/judge.ts");
    for (const key of ["customInput", "noSampleCase"]) {
      expect(action, `the submit boundary must refuse with INTERACTIVE_REFUSALS.${key}`).toContain(
        `INTERACTIVE_REFUSALS.${key}`,
      );
    }
  });
});

describe("a case with no expected output shows none", () => {
  it("the console leaves the expected block out for a conversation", () => {
    const resultView = readRepoFile(`${WORKSPACE}/result-view.tsx`);
    // `talk` is the flag; the expected block is behind !talk.
    expect(resultView).toContain("{!talk &&");
    expect(resultView).toContain('view.compareMode === "INTERACTIVE"');
  });

  it("and so does the statement", () => {
    expect(readRepoFile(`${WORKSPACE}/problem-description.tsx`)).toContain('problem.compareMode === "INTERACTIVE"');
  });
});

describe("not in an assessment yet, and not quietly", () => {
  it("a trigger refuses the pin", () => {
    const migration = readRepoFile("packages/db/prisma/migrations/20261101140500_phase12l_assessment_rule/migration.sql");
    expect(migration).toContain("AssessmentProblem_no_interactive");
    expect(migration).toContain("two clean practice contests");
  });

  it("the action says so in a sentence first", () => {
    const action = readRepoFile("apps/web/src/server/actions/admin-assessments.ts");
    expect(action).toContain("not sat in an assessment yet");
  });

  it("the trigger and its function are catalogued, so lifting the rule fails the build", () => {
    const catalog = readRepoFile("packages/db/test/support/guard-catalog.ts");
    expect(catalog).toContain("AssessmentProblem_no_interactive");
    expect(catalog).toContain("recx_refuse_interactive_assessment_problem");
  });

  it("a contest may hold one: the trigger is on assessments only", () => {
    // The comment explains the asymmetry; what matters is that no trigger
    // was put on ContestProblem, because SPEC asks for the opposite there.
    const migration = readRepoFile("packages/db/prisma/migrations/20261101140500_phase12l_assessment_rule/migration.sql");
    expect(migration).toMatch(/CREATE TRIGGER[\s\S]*ON "public"\."AssessmentProblem"/);
    expect(migration).not.toMatch(/ON "public"\."ContestProblem"/);
  });
});
