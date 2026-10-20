import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ResultPanel } from "@/components/workspace/result-panel";
import {
  formatMemoryKb,
  formatPoints,
  formatScore,
  formatTimeMs,
  isSampleTest,
  subtaskLabel,
  testLabel,
  toStudentView,
  type RunViewSource,
  type SubmissionViewSource,
  type TestMeta,
} from "@/lib/judge/view";

const created = new Date("2026-10-10T08:00:00Z");
const judged = new Date("2026-10-10T08:00:03Z");

const samples = [
  { index: 0, input: "[2,7,11,15]\n9\n", expected: "[0,1]\n" },
  { index: 1, input: "[3,2,4]\n6\n", expected: "[1,2]\n" },
];

/** Everything the worker could conceivably have stored for a test. */
function leakyEntry(i: number, v = "AC") {
  return {
    i,
    v,
    ms: 12.4,
    kb: 3_000,
    exitCode: 0,
    signal: null,
    idle: false,
    stdout: `stdout-${i}`,
    stderr: `stderr-${i}`,
    input: `input-${i}`,
    expected: `expected-${i}`,
    diff: `diff-${i}`,
    message: "secret",
  };
}

function submission(overrides: Partial<SubmissionViewSource> = {}): SubmissionViewSource {
  return {
    kind: "submission",
    id: "sub_1",
    status: "DONE",
    verdict: "WA",
    language: "cpp20",
    languageLabel: "C++20 (GCC 13.2.0)",
    compileOutput: null,
    createdAt: created,
    judgedAt: judged,
    samples,
    passedCases: 3,
    totalCases: 14,
    maxTimeMs: 12,
    maxMemoryKb: 3_000,
    testResults: [leakyEntry(0), leakyEntry(1), leakyEntry(2), leakyEntry(6, "WA")],
    details: [{ testIndex: 1, input: "[3,2,4]\n6\n", expected: "[1,2]\n", stdout: "[1,2]\n", stderr: "" }],
    ...overrides,
  };
}

describe("toStudentView — submissions", () => {
  it("a hidden test entry has exactly the keys i, v, ms, kb", () => {
    const view = toStudentView(submission());
    const hidden = view.tests.filter((t) => !isSampleTest(t));
    expect(hidden).toHaveLength(2);
    for (const t of hidden) {
      expect(Object.keys(t).sort()).toEqual(["i", "kb", "ms", "v"]);
    }
    expect(hidden[1]).toEqual({ i: 6, v: "WA", ms: 12, kb: 3_000 });
  });

  it("never serialises hidden-test input, expected output, stdout, stderr or diff", () => {
    const json = JSON.stringify(toStudentView(submission()));
    for (const i of [2, 6]) {
      for (const field of ["input", "expected", "stdout", "stderr", "diff"]) {
        expect(json).not.toContain(`${field}-${i}`);
      }
    }
    expect(json).not.toContain("secret");
    expect(json).not.toContain("exitCode");
  });

  it("labels samples and hidden tests", () => {
    const view = toStudentView(submission());
    expect(view.tests.map(testLabel)).toEqual(["Sample 1", "Sample 2", "Hidden test 3", "Hidden test 7"]);
  });

  it("shows sample input, expected and the contestant's output, preferring the detail row", () => {
    const view = toStudentView(submission());
    const [first, second] = view.tests;
    if (!first || !second || !isSampleTest(first) || !isSampleTest(second)) throw new Error("expected samples");
    // No detail row for sample 0: falls back to the sample blobs + stored stdout.
    expect(first.sample).toEqual({
      n: 1,
      input: "[2,7,11,15]\n9\n",
      expected: "[0,1]\n",
      stdout: "stdout-0",
      stderr: "stderr-0",
    });
    expect(second.sample).toEqual({ n: 2, input: "[3,2,4]\n6\n", expected: "[1,2]\n", stdout: "[1,2]\n", stderr: "" });
  });

  it("truncates sample fields to 256 bytes with a visible marker", () => {
    const long = "9".repeat(5_000);
    const view = toStudentView(
      submission({ details: [{ testIndex: 0, input: long, expected: long, stdout: long, stderr: long }] }),
    );
    const t = view.tests[0];
    if (!t || !isSampleTest(t)) throw new Error("expected a sample");
    for (const field of [t.sample.input, t.sample.expected, t.sample.stdout, t.sample.stderr]) {
      expect(field).not.toBeNull();
      expect(new TextEncoder().encode(field!).byteLength).toBeLessThanOrEqual(256);
      expect(field).toContain("(truncated)");
    }
  });

  it("maps pending states and terminal flags", () => {
    expect(toStudentView(submission({ status: "QUEUED", verdict: null })).display).toBe("QUEUED");
    const judging = toStudentView(submission({ status: "JUDGING", verdict: null }));
    expect(judging.display).toBe("RUNNING");
    expect(judging.terminal).toBe(false);
    const ie = toStudentView(submission({ status: "INTERNAL_ERROR", verdict: null }));
    expect(ie.display).toBe("IE");
    expect(ie.terminal).toBe(true);
    expect(toStudentView(submission({ verdict: "PARTIAL" })).display).toBe("PARTIAL");
    expect(toStudentView(submission({ verdict: "not-a-verdict" })).display).toBe("IE");
  });

  it("shows compile output only for a CE", () => {
    const ce = toStudentView(
      submission({ verdict: "CE", testResults: [], compileOutput: "solution.cpp:3:5: error: expected ';'" }),
    );
    expect(ce.compileOutput).toContain("expected ';'");
    expect(ce.tests).toEqual([]);
    const wa = toStudentView(submission({ compileOutput: "warning: unused variable" }));
    expect(wa.compileOutput).toBeNull();
  });

  it("re-sanitises compile output (no box or toolchain paths)", () => {
    const ce = toStudentView(
      submission({
        verdict: "CE",
        testResults: [],
        compileOutput: "/box/main.cpp:1:1: error: x\nIn file included from /opt/toolchains/gcc-13.2.0/include/c++/vector:1",
      }),
    );
    expect(ce.compileOutput).not.toContain("/box/");
    expect(ce.compileOutput).not.toContain("/opt/toolchains/");
  });

  it("tolerates malformed stored results", () => {
    const view = toStudentView(submission({ testResults: [null, 3, { i: -1, v: "AC" }, { i: 4, v: "NOPE" }, "x"] }));
    expect(view.tests).toEqual([]);
    expect(toStudentView(submission({ testResults: null })).tests).toEqual([]);
  });

  it("serialises dates as ISO strings", () => {
    const view = toStudentView(submission());
    expect(view.createdAt).toBe("2026-10-10T08:00:00.000Z");
    expect(view.judgedAt).toBe("2026-10-10T08:00:03.000Z");
  });
});

describe("toStudentView — runs", () => {
  function run(overrides: Partial<RunViewSource> = {}): RunViewSource {
    return {
      kind: "run",
      id: "run_1",
      status: "DONE",
      verdict: "AC",
      language: "py312",
      languageLabel: "Python 3.12 (CPython 3.12.6, numpy 1.26.4)",
      compileOutput: null,
      createdAt: created,
      judgedAt: judged,
      samples,
      customInput: null,
      result: [leakyEntry(0), leakyEntry(1)],
      ...overrides,
    };
  }

  it("sample runs show samples with truncated detail", () => {
    const view = toStudentView(run());
    expect(view.isCustom).toBe(false);
    expect(view.custom).toBeNull();
    expect(view.tests.map(testLabel)).toEqual(["Sample 1", "Sample 2"]);
    expect(view.passed).toBe(2);
    expect(view.total).toBe(2);
  });

  it("a non-sample entry in a run is still reduced to i, v, ms, kb", () => {
    const view = toStudentView(run({ result: [leakyEntry(0), leakyEntry(9)] }));
    const hidden = view.tests.find((t) => t.i === 9);
    expect(hidden && Object.keys(hidden).sort()).toEqual(["i", "kb", "ms", "v"]);
    expect(JSON.stringify(view)).not.toContain("stdout-9");
  });

  it("custom runs show stdout up to 64 KB and stderr up to 8 KB", () => {
    const view = toStudentView(
      run({
        customInput: "[1,2]\n3\n",
        result: [{ i: 0, v: "AC", ms: 5, kb: 900, stdout: "o".repeat(70_000), stderr: "e".repeat(10_000) }],
      }),
    );
    expect(view.isCustom).toBe(true);
    expect(view.tests).toEqual([]);
    expect(view.custom).not.toBeNull();
    expect(new TextEncoder().encode(view.custom!.stdout).byteLength).toBeLessThanOrEqual(64 * 1024);
    expect(view.custom!.stdout).toContain("(truncated)");
    expect(new TextEncoder().encode(view.custom!.stderr).byteLength).toBeLessThanOrEqual(8 * 1024);
  });

  it("custom runs that fail to compile show the compile output instead", () => {
    const view = toStudentView(
      run({ customInput: "1\n", verdict: "CE", compileOutput: 'File "solution.py", line 2\nSyntaxError', result: [] }),
    );
    expect(view.custom).toBeNull();
    expect(view.compileOutput).toContain("SyntaxError");
  });

  it("pending runs have no custom output yet", () => {
    const view = toStudentView(run({ status: "JUDGING", verdict: null, customInput: "1\n", result: null }));
    expect(view.display).toBe("RUNNING");
    expect(view.custom).toBeNull();
  });
});

describe("toStudentView — scoring", () => {
  /** Tests 0–1 are samples (subtask 0), 2–3 subtask 1, 4–5 subtask 2. */
  const meta: TestMeta[] = [0, 1, 2, 3, 4, 5].map((index) => ({
    index,
    points: index < 2 ? 0 : 10,
    subtask: Math.floor(index / 2),
  }));

  function subtaskSubmission(overrides: Partial<SubmissionViewSource> = {}) {
    return submission({
      verdict: "PARTIAL",
      passedCases: 4,
      totalCases: 6,
      scoringMode: "SUBTASK",
      score: 62,
      maxScore: 100,
      testMeta: meta,
      subtaskResults: [
        { index: 1, earned: 40, max: 40, verdict: "AC" },
        { index: 0, earned: 22, max: 22, verdict: "AC" },
        { index: 2, earned: 0, max: 38, verdict: "WA" },
      ],
      testResults: [leakyEntry(0), leakyEntry(1), leakyEntry(2), leakyEntry(3), leakyEntry(4, "WA"), leakyEntry(5, "SKIPPED")],
      ...overrides,
    });
  }

  it("reports the overall score and each subtask with its tests", () => {
    const view = toStudentView(subtaskSubmission());
    expect(view.display).toBe("PARTIAL");
    expect(view.passed).toBe(4);
    expect(view.total).toBe(6);
    expect(view.scoring).toEqual({
      mode: "SUBTASK",
      score: 62,
      maxScore: 100,
      subtasks: [
        { index: 0, earned: 22, max: 22, verdict: "AC", tests: [0, 1] },
        { index: 1, earned: 40, max: 40, verdict: "AC", tests: [2, 3] },
        { index: 2, earned: 0, max: 38, verdict: "WA", tests: [4, 5] },
      ],
      ungrouped: [],
      testPoints: [],
    });
    expect(formatScore(view.scoring!.score, view.scoring!.maxScore)).toBe("62 / 100");
    expect(subtaskLabel(0)).toBe("Subtask 1");
  });

  it("keeps hidden tests to i, v, ms, kb even with subtasks and points", () => {
    const view = toStudentView(subtaskSubmission());
    for (const t of view.tests.filter((x) => !isSampleTest(x))) {
      expect(Object.keys(t).sort()).toEqual(["i", "kb", "ms", "v"]);
    }
    const json = JSON.stringify(view);
    for (const i of [2, 3, 4, 5]) {
      for (const field of ["input", "expected", "stdout", "stderr", "diff"]) expect(json).not.toContain(`${field}-${i}`);
    }
  });

  it("lists tests in no reported subtask separately", () => {
    const view = toStudentView(
      subtaskSubmission({
        testMeta: [...meta, { index: 6, points: 5, subtask: null }, { index: 7, points: 5, subtask: 9 }],
      }),
    );
    expect(view.scoring?.ungrouped).toEqual([6, 7]);
  });

  it("infers SUBTASK from stored subtask results when the caller gives no mode", () => {
    const view = toStudentView(subtaskSubmission({ scoringMode: undefined }));
    expect(view.scoring?.mode).toBe("SUBTASK");
    const none = toStudentView(subtaskSubmission({ scoringMode: undefined, subtaskResults: null }));
    expect(none.scoring).toBeNull();
  });

  it("ignores malformed stored subtask entries", () => {
    const view = toStudentView(
      subtaskSubmission({ subtaskResults: [{ index: 1, earned: 40, max: 40, verdict: "AC" }, { index: -1 }, "x", null] }),
    );
    expect(view.scoring?.subtasks.map((s) => s.index)).toEqual([1]);
  });

  it("PER_TEST: points per test, partial credit from the stored total", () => {
    const perTest = submission({
      verdict: "PARTIAL",
      scoringMode: "PER_TEST",
      score: 27.5,
      maxScore: 40,
      testMeta: [
        { index: 0, points: null, subtask: null },
        { index: 1, points: null, subtask: null },
        { index: 2, points: 18, subtask: null },
        { index: 6, points: 20, subtask: null },
      ],
      testResults: [leakyEntry(0), leakyEntry(1, "WA"), leakyEntry(2, "AC"), leakyEntry(6, "PARTIAL")],
    });
    const view = toStudentView(perTest);
    expect(view.scoring).toMatchObject({ mode: "PER_TEST", score: 27.5, maxScore: 40, subtasks: [] });
    // 1 (unweighted sample) + 0 + 18 known; the one PARTIAL test earned the remaining 8.5.
    expect(view.scoring?.testPoints).toEqual([
      { i: 0, earned: 1, max: 1 },
      { i: 1, earned: 0, max: 1 },
      { i: 2, earned: 18, max: 18 },
      { i: 6, earned: 8.5, max: 20 },
    ]);
    // Two partial tests: their individual shares are not stored, so unknown.
    const two = toStudentView({
      ...perTest,
      testResults: [leakyEntry(0), leakyEntry(1, "WA"), leakyEntry(2, "PARTIAL"), leakyEntry(6, "PARTIAL")],
    });
    expect(two.scoring?.testPoints.filter((p) => p.earned === null).map((p) => p.i)).toEqual([2, 6]);
    // Hidden test entries themselves still carry no points.
    expect(Object.keys(view.tests.find((t) => t.i === 6)!).sort()).toEqual(["i", "kb", "ms", "v"]);
  });

  it("no scoring block for ICPC, unfinished, IE or unscored submissions", () => {
    expect(toStudentView(submission({ scoringMode: "ICPC", score: 1, maxScore: 1 })).scoring).toBeNull();
    expect(toStudentView(subtaskSubmission({ status: "JUDGING", verdict: null })).scoring).toBeNull();
    expect(toStudentView(subtaskSubmission({ status: "INTERNAL_ERROR", verdict: "IE" })).scoring).toBeNull();
    expect(toStudentView(subtaskSubmission({ maxScore: null })).scoring).toBeNull();
    expect(toStudentView(subtaskSubmission({ maxScore: 0 })).scoring).toBeNull();
    expect(toStudentView(submission()).scoring).toBeNull();
  });

  it("a compile error keeps its score of 0 out of the maximum", () => {
    const ce = toStudentView(
      subtaskSubmission({ verdict: "CE", score: 0, testResults: [], subtaskResults: [], compileOutput: "error" }),
    );
    expect(ce.scoring).toMatchObject({ mode: "SUBTASK", score: 0, maxScore: 100 });
  });

  it("formats points without float noise", () => {
    expect(formatPoints(62)).toBe("62");
    expect(formatPoints(12.5)).toBe("12.5");
    expect(formatPoints(100 / 3)).toBe("33.33");
    expect(formatPoints(0.1 + 0.2)).toBe("0.3");
    expect(formatScore(8.5, 20)).toBe("8.5 / 20");
  });
});

describe("ResultPanel — scored submissions", () => {
  const meta: TestMeta[] = [
    { index: 0, points: 0, subtask: 0 },
    { index: 1, points: 10, subtask: 1 },
    { index: 2, points: 10, subtask: 1 },
    { index: 3, points: 10, subtask: 2 },
  ];

  // apps/web's vitest config compiles .tsx with the classic JSX runtime.
  (globalThis as { React?: typeof React }).React = React;

  function render(source: SubmissionViewSource): string {
    const view = toStudentView(source);
    return renderToStaticMarkup(
      React.createElement(ResultPanel, {
        target: { kind: "submission", id: view.id },
        sending: null,
        stream: { view, progress: null, phase: "done", error: null, retry: () => undefined },
        sampleIndexes: [0, 1],
      }),
    );
  }

  it("shows the score, PARTIAL with passed/total, and each subtask with its tests", () => {
    const html = render(
      submission({
        verdict: "PARTIAL",
        passedCases: 3,
        totalCases: 4,
        scoringMode: "SUBTASK",
        score: 62,
        maxScore: 100,
        testMeta: meta,
        subtaskResults: [
          { index: 0, earned: 22, max: 22, verdict: "AC" },
          { index: 1, earned: 40, max: 40, verdict: "AC" },
          { index: 2, earned: 0, max: 38, verdict: "WA" },
        ],
        testResults: [leakyEntry(0), leakyEntry(1), leakyEntry(2), leakyEntry(3, "WA")],
      }),
    );
    expect(html).toContain("62 / 100");
    // PARTIAL goes through VerdictBadge with passed/total.
    expect(html).toContain('data-verdict="PARTIAL"');
    expect(html).toContain("3/4");
    for (const label of ["Subtask 1", "Subtask 2", "Subtask 3"]) expect(html).toContain(label);
    const text = html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, "");
    expect(text).toContain("40 / 40 points");
    expect(text).toContain("0 / 38 points");
    expect(html).toContain("Hidden test 4");
    // Hidden test content never reaches the markup.
    for (const field of ["input", "expected", "stdout", "stderr", "diff"]) expect(html).not.toContain(`${field}-3`);
  });

  it("shows per-test points for PER_TEST problems", () => {
    const html = render(
      submission({
        verdict: "PARTIAL",
        scoringMode: "PER_TEST",
        score: 20,
        maxScore: 30,
        testMeta: meta,
        testResults: [leakyEntry(0), leakyEntry(1), leakyEntry(2), leakyEntry(3, "WA")],
      }),
    );
    expect(html).toContain("20 / 30");
    expect(html.replace(/<!-- -->/g, "")).toContain("0 / 10 pts");
    expect(html.replace(/<!-- -->/g, "")).toContain("10 / 10 pts");
  });

  it("an ICPC submission shows no score line", () => {
    const html = render(submission({ scoringMode: "ICPC", score: 0, maxScore: 1 }));
    expect(html).not.toContain("Score");
    expect(html).toContain('data-verdict="WA"');
  });
});

describe("formatting", () => {
  it("formats time and memory", () => {
    expect(formatTimeMs(12)).toBe("12 ms");
    expect(formatTimeMs(null)).toBe("—");
    expect(formatMemoryKb(812)).toBe("812 KB");
    expect(formatMemoryKb(3_072)).toBe("3.0 MB");
    expect(formatMemoryKb(262_144)).toBe("256 MB");
    expect(formatMemoryKb(null)).toBe("—");
  });
});
