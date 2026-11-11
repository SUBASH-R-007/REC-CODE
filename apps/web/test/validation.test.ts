import { describe, expect, it, vi } from "vitest";
import { deriveTimeLimitMs, LANGUAGE_CATALOG, type Verdict } from "@recx/shared";

// The pure decisions never reach the database, Redis or the store.
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/judge/queue", () => ({ enqueueJudge: vi.fn() }));

const {
  deriveLanguageLimits,
  effectiveVerdict,
  generationOf,
  stageOf,
  summarizeValidation,
  validationOutcome,
} = await import("@/lib/judge/validation");
type ReferenceState = import("@/lib/judge/validation").ReferenceState;
type ValidationRunState = import("@/lib/judge/validation").ValidationRunState;

const T0 = new Date("2026-10-10T05:00:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

let seq = 0;
function run(overrides: Partial<ValidationRunState> = {}): ValidationRunState {
  return {
    id: `run-${++seq}`,
    status: "DONE",
    outcome: "MATCHED",
    verdict: "AC",
    measuredMs: 40,
    createdAt: at(0),
    ...overrides,
  };
}

function ref(
  language: string,
  expectedVerdict: Verdict,
  latest: ValidationRunState | null,
  overrides: Partial<ReferenceState> = {},
): ReferenceState {
  return { id: `ref-${++seq}`, language, label: null, expectedVerdict, runnable: true, latest, ...overrides };
}

/** A fully validated problem: C++ and Python models, a C++ brute force that TLEs. */
function complete(): ReferenceState[] {
  return [
    ref("cpp20", "AC", run({ measuredMs: 30 })),
    ref("py312", "AC", run({ measuredMs: 210 })),
    ref("cpp20", "TLE", run({ verdict: "PARTIAL", createdAt: at(60) })),
  ];
}

describe("validation outcome", () => {
  it("matches the expected verdict exactly", () => {
    expect(validationOutcome("AC", "AC", [])).toBe("MATCHED");
    expect(validationOutcome("WA", "WA", [{ v: "AC" }, { v: "WA" }])).toBe("MATCHED");
    expect(validationOutcome("AC", "WA", [{ v: "WA" }])).toBe("MISMATCHED");
    expect(validationOutcome("TLE", "WA", [{ v: "WA" }])).toBe("MISMATCHED");
  });

  it("reads a partially scored run by its worst failing test", () => {
    const bruteForce = [{ v: "AC" as const }, { v: "AC" as const }, { v: "TLE" as const }, { v: "SKIPPED" as const }];
    expect(effectiveVerdict("PARTIAL", bruteForce)).toBe("TLE");
    expect(validationOutcome("TLE", "PARTIAL", bruteForce)).toBe("MATCHED");
    expect(validationOutcome("WA", "PARTIAL", bruteForce)).toBe("MISMATCHED");
    // A model solution that only partially passes is never AC.
    expect(validationOutcome("AC", "PARTIAL", bruteForce)).toBe("MISMATCHED");
  });

  it("keeps PARTIAL when nothing failed outright", () => {
    expect(effectiveVerdict("PARTIAL", [{ v: "AC" }, { v: "PARTIAL" }])).toBe("PARTIAL");
    expect(validationOutcome("PARTIAL", "PARTIAL", [{ v: "PARTIAL" }])).toBe("MATCHED");
  });

  it("puts model solutions in stage 1 and everything else in stage 2", () => {
    expect(stageOf("AC")).toBe(1);
    for (const v of ["WA", "TLE", "MLE", "RE"] as const) expect(stageOf(v)).toBe(2);
  });
});

describe("publish gate", () => {
  it("allows a version whose models and deliberately-wrong solutions all matched", () => {
    const summary = summarizeValidation(complete());
    expect(summary).toMatchObject({ phase: "COMPLETE", publishable: true, blockers: [] });
  });

  it("allows a cpp17 model as the C++ model solution", () => {
    const refs = [ref("cpp17", "AC", run()), ref("py312", "AC", run())];
    expect(summarizeValidation(refs).publishable).toBe(true);
  });

  it("blocks without a C++ model solution, even when every other model matched", () => {
    const summary = summarizeValidation([ref("py312", "AC", run())]);
    expect(summary.publishable).toBe(false);
    expect(summary.blockers).toContain("No C++ (cpp17 / cpp20) model solution exists.");
  });

  it("asks each kind of problem for its own model solution", () => {
    /**
     * The live stage of Phase 12n, slice 3 found this: the content gate's
     * C++ warning had been lifted for an output-only problem but this
     * BLOCKER had not, so a question whose model answer had just been
     * judged AC could not be approved for want of a C++ program it will
     * never have.
     */
    const answer = summarizeValidation([ref("answer1", "AC", run())], "OUTPUT_ONLY");
    expect(answer.blockers).toEqual([]);
    expect(answer.publishable).toBe(true);

    const noAnswer = summarizeValidation([ref("cpp20", "AC", run())], "OUTPUT_ONLY");
    expect(noAnswer.blockers.join(" ")).toContain("No model answer");

    // And the other two kinds still ask for what they asked for.
    expect(summarizeValidation([ref("sql17", "AC", run())], "SQL").blockers).toEqual([]);
    expect(summarizeValidation([ref("answer1", "AC", run())], "STDIN").blockers.join(" ")).toContain("No C++");
  });

  it("blocks when the C++ model's language is not enabled", () => {
    const refs = [ref("cpp17", "AC", null, { runnable: false }), ref("py312", "AC", run())];
    const summary = summarizeValidation(refs);
    expect(summary.publishable).toBe(false);
    expect(summary.blockers.join(" ")).toMatch(/C\+\+ model solution is in a language that is not enabled/);
    expect(summary.notes[0]).toMatch(/not run: its language is not enabled/);
  });

  it("blocks when any model solution did not match (stage 1 failed; stage 2 never starts)", () => {
    const refs = [
      ref("cpp20", "AC", run()),
      ref("py312", "AC", run({ outcome: "MISMATCHED", verdict: "TLE" })),
      ref("cpp20", "TLE", null),
    ];
    const summary = summarizeValidation(refs);
    expect(summary.phase).toBe("STAGE1_FAILED");
    expect(summary.publishable).toBe(false);
    expect(summary.blockers.join(" ")).toMatch(/Model solution failed: .*py312.*produced TLE/);
    expect(summary.stage2Needed).toEqual([]);
  });

  it("blocks when a model solution hit an internal error", () => {
    const refs = [ref("cpp20", "AC", run({ status: "INTERNAL_ERROR", outcome: "FAILED", verdict: "IE" }))];
    expect(summarizeValidation(refs).blockers.join(" ")).toMatch(/internal error/);
  });

  it("blocks when a deliberately-wrong solution passed", () => {
    const refs = complete();
    refs[2] = ref("cpp20", "TLE", run({ verdict: "AC", outcome: "MISMATCHED", createdAt: at(60) }));
    const summary = summarizeValidation(refs);
    expect(summary.phase).toBe("COMPLETE");
    expect(summary.publishable).toBe(false);
    expect(summary.blockers.join(" ")).toMatch(/did not fail as expected: .*expected TLE.*produced AC/);
  });

  it("asks for stage 2 once every model matched", () => {
    const refs = complete();
    refs[2] = ref("cpp20", "TLE", null);
    const summary = summarizeValidation(refs);
    expect(summary.phase).toBe("STAGE2_NEEDED");
    expect(summary.stage2Needed).toEqual([refs[2]!.id]);
    expect(summary.publishable).toBe(false);
  });

  it("does not count a stage-2 run from an earlier round", () => {
    const refs = [
      ref("cpp20", "AC", run({ createdAt: at(100) })),
      ref("cpp20", "WA", run({ verdict: "WA", createdAt: at(50) })),
    ];
    expect(summarizeValidation(refs).phase).toBe("STAGE2_NEEDED");
  });

  it("reports pending work in either stage", () => {
    const stage1 = summarizeValidation([ref("cpp20", "AC", run({ status: "JUDGING", outcome: "PENDING", verdict: null }))]);
    expect(stage1).toMatchObject({ phase: "STAGE1_RUNNING", pending: 1, publishable: false });
    const refs = complete();
    refs[2] = ref("cpp20", "TLE", run({ status: "QUEUED", outcome: "PENDING", verdict: null, createdAt: at(60) }));
    expect(summarizeValidation(refs)).toMatchObject({ phase: "STAGE2_RUNNING", pending: 1, publishable: false });
  });

  it("needs a (re)start when a model has no run or its run was cancelled", () => {
    expect(summarizeValidation([ref("cpp20", "AC", null)]).phase).toBe("NOT_STARTED");
    expect(summarizeValidation([ref("cpp20", "AC", run({ status: "CANCELLED", outcome: "PENDING" }))]).phase).toBe(
      "NOT_STARTED",
    );
  });

  it("ignores reference solutions in languages that are not enabled", () => {
    const refs = [...complete(), ref("java21", "AC", null, { runnable: false }), ref("go123", "WA", null, { runnable: false })];
    const summary = summarizeValidation(refs);
    expect(summary.publishable).toBe(true);
    expect(summary.notes).toHaveLength(2);
  });
});

describe("derived language limits", () => {
  const languages = (["cpp20", "py312", "java21"] as const).map((key) => ({
    key,
    fallbackMultiplier: LANGUAGE_CATALOG[key].fallbackMultiplier,
    fallbackExtraMs: LANGUAGE_CATALOG[key].fallbackExtraMs,
  }));

  it("uses each language's worst model solution, and the fallback elsewhere", () => {
    const rows = deriveLanguageLimits({
      baseMs: 1000,
      memoryLimitKb: 262_144,
      languages,
      ioMode: "STDIN",
      measurements: [
        { language: "cpp20", measuredMs: 120, generation: "w/a/1000" },
        { language: "py312", measuredMs: 900, generation: "w/a/1000" },
        { language: "py312", measuredMs: 1300, generation: "w/b/990" },
      ],
    });
    expect(rows.map((r) => r.language)).toEqual(["cpp20", "java21", "py312"]);
    const by = Object.fromEntries(rows.map((r) => [r.language, r]));
    // C++: max(2.5 × 120, 1000) = 1000
    expect(by.cpp20).toMatchObject({ timeLimitMs: 1000, measuredModelMs: 120, measuredOnGeneration: "w/a/1000" });
    // Python: ceil_100(2.5 × 1300) = 3300, measured on the slower run
    expect(by.py312).toMatchObject({ timeLimitMs: 3300, measuredModelMs: 1300, measuredOnGeneration: "w/b/990" });
    // Java (no model): the fallback multiplier
    expect(by.java21).toMatchObject({
      timeLimitMs: deriveTimeLimitMs({
        baseMs: 1000,
        measuredModelMs: null,
        multiplier: LANGUAGE_CATALOG.java21.fallbackMultiplier,
        extraMs: LANGUAGE_CATALOG.java21.fallbackExtraMs,
      }),
      measuredModelMs: null,
      measuredOnGeneration: null,
    });
    for (const row of rows) expect(row.memoryLimitKb).toBe(262_144);
  });

  it("gives a limit only to a language the problem can be answered in", () => {
    /**
     * Phase 12l, found by the live stage: an interactive problem came out
     * of its first publish with a `sql17` time limit beside its C++ one.
     * A limit for a language a student cannot choose is a stored row that
     * reads as meaningful.
     */
    const withSql = [...languages, { key: "sql17", fallbackMultiplier: 1, fallbackExtraMs: 0 }];
    const program = deriveLanguageLimits({
      baseMs: 1000,
      memoryLimitKb: 262_144,
      languages: withSql,
      ioMode: "STDIN",
      measurements: [],
    });
    expect(program.map((r) => r.language)).toEqual(["cpp20", "java21", "py312"]);

    // And the other way round: a SQL problem is answered with SQL alone.
    const query = deriveLanguageLimits({
      baseMs: 5000,
      memoryLimitKb: 262_144,
      languages: withSql,
      ioMode: "SQL",
      measurements: [],
    });
    expect(query.map((r) => r.language)).toEqual(["sql17"]);
  });

  it("records where a measurement was taken", () => {
    expect(generationOf({ judgeNodeId: "judge-1", calibrationScore: 1012.5 }, "0.2.0")).toBe("0.2.0/judge-1/1012.5");
    expect(generationOf({ judgeNodeId: null, calibrationScore: null }, null)).toBe("unknown/unknown/uncalibrated");
  });
});

describe("the FUNCTION runnable rule", () => {
  it("does not run a reference in a language without a function harness, with its own note", async () => {
    const { referenceRunnability } = await import("@/lib/judge/validation");
    const enabled = new Set(["cpp20", "py312", "go123", "node22"]);
    expect(referenceRunnability("cpp20", "FUNCTION", enabled)).toEqual({ runnable: true });
    expect(referenceRunnability("go123", "FUNCTION", enabled)).toEqual({ runnable: false, unrunnable: "no-harness" });
    expect(referenceRunnability("go123", "STDIN", enabled)).toEqual({ runnable: true });
    expect(referenceRunnability("java21", "FUNCTION", enabled)).toEqual({ runnable: false, unrunnable: "disabled" });

    const summary = summarizeValidation([
      ref("cpp20", "AC", run()),
      ref("node22", "AC", null, { runnable: false, unrunnable: "no-harness" }),
      ref("java21", "AC", null, { runnable: false, unrunnable: "disabled" }),
    ]);
    expect(summary.publishable).toBe(true);
    expect(summary.notes).toEqual([
      "reference solution (node22, expected AC) was not run: its language has no function harness",
      "reference solution (java21, expected AC) was not run: its language is not enabled",
    ]);
  });
});
