import { describe, expect, it } from "vitest";
import { RUN_OUTCOME_RULES, type LanguageKey, type RunOutcomeRuleId } from "@recx/shared";
import { classifyRun, type RunContext } from "../src/judge/verdict";
import type { IsolateMeta } from "../src/sandbox/types";

/**
 * The /judge page publishes RUN_OUTCOME_RULES (@recx/shared) as the order in
 * which one test's run is classified. This suite binds that published list
 * to the worker's real classifyRun():
 *
 *   1. one fixture per rule, in the published order, that matches its own
 *      rule AND at least one later rule with a different verdict — so the
 *      fixture only gets the published verdict if the order is the real one;
 *   2. an exhaustive grid of isolate metas and contexts, each classified by
 *      an independent restatement of the rules (first match wins) and by
 *      classifyRun, which must agree on every combination.
 */

const LIMIT_MS = 1_000;
const MEMORY_KB = 262_144;

const META: IsolateMeta = {
  status: null,
  timeSec: 0.05,
  wallSec: 0.06,
  maxRssKb: 9_600,
  cgMemKb: 10_000,
  cgOomKilled: false,
  exitCode: 0,
  exitSignal: null,
  killed: false,
  message: null,
};

const CTX: RunContext = {
  timeLimitMs: LIMIT_MS,
  memoryLimitKb: MEMORY_KB,
  language: "cpp20",
  stderr: "",
  outputLimitExceeded: false,
};

const JVM: ReadonlySet<LanguageKey> = new Set(["java21", "kotlin20"]);
const PYTHON: ReadonlySet<LanguageKey> = new Set(["py312", "pypy310"]);

const exitedBadly = (m: IsolateMeta) => m.status === "RE" || (m.exitCode !== null && m.exitCode !== 0);

/** Each published rule restated from its description (not from the worker's code). */
const MATCHES: Readonly<Record<RunOutcomeRuleId, (m: IsolateMeta, c: RunContext) => boolean>> = {
  "sandbox-failure": (m) => m.status === "XX",
  "output-trip": (_m, c) => c.outputLimitExceeded,
  "time-limit": (m) => m.status === "TO",
  "cpu-overrun": (m, c) => Math.round((m.timeSec ?? 0) * 1000) > c.timeLimitMs,
  "memory-limit": (m, c) => m.cgOomKilled || (m.cgMemKb !== null && m.cgMemKb >= c.memoryLimitKb),
  "file-size-signal": (m) => m.status === "SG" && m.exitSignal === 25,
  signal: (m) => m.status === "SG",
  "runtime-out-of-memory": (m, c) =>
    exitedBadly(m) &&
    ((JVM.has(c.language) && m.exitCode === 1 && c.stderr.includes("java.lang.OutOfMemoryError")) ||
      (PYTHON.has(c.language) && /(^|\n)MemoryError\b/.test(c.stderr))),
  "exit-code": exitedBadly,
  compare: () => true,
};

function firstMatch(m: IsolateMeta, c: RunContext) {
  const rule = RUN_OUTCOME_RULES.find((r) => MATCHES[r.id](m, c));
  if (!rule) throw new Error("the compare rule always matches");
  return rule;
}

/** Each fixture also satisfies later rules, at least one with another verdict. */
const FIXTURES: Record<RunOutcomeRuleId, { meta: Partial<IsolateMeta>; ctx: Partial<RunContext> }> = {
  "sandbox-failure": {
    meta: { status: "XX", timeSec: 2, cgOomKilled: true, exitCode: 1 },
    ctx: { outputLimitExceeded: true, language: "py312", stderr: "MemoryError" },
  },
  "output-trip": { meta: { status: "TO", timeSec: 2, cgOomKilled: true }, ctx: { outputLimitExceeded: true } },
  "time-limit": { meta: { status: "TO", timeSec: 2, cgOomKilled: true, exitCode: null }, ctx: {} },
  "cpu-overrun": { meta: { status: "SG", exitSignal: 25, exitCode: null, timeSec: 1.2, cgOomKilled: true }, ctx: {} },
  "memory-limit": { meta: { status: "SG", exitSignal: 25, exitCode: null, cgOomKilled: true }, ctx: {} },
  "file-size-signal": { meta: { status: "SG", exitSignal: 25, exitCode: null }, ctx: {} },
  signal: {
    meta: { status: "SG", exitSignal: 11, exitCode: 1 },
    ctx: { language: "py312", stderr: "Traceback (most recent call last):\nMemoryError\n" },
  },
  "runtime-out-of-memory": {
    meta: { status: "RE", exitCode: 1 },
    ctx: { language: "java21", stderr: 'Exception in thread "main" java.lang.OutOfMemoryError: Java heap space' },
  },
  "exit-code": { meta: { status: "RE", exitCode: 3 }, ctx: {} },
  compare: { meta: { status: null, exitCode: 0 }, ctx: {} },
};

const meta = (patch: Partial<IsolateMeta>): IsolateMeta => ({ ...META, ...patch });
const ctx = (patch: Partial<RunContext>): RunContext => ({ ...CTX, ...patch });

describe("RUN_OUTCOME_RULES is the worker's real order", () => {
  it("has one fixture per published rule, in the published order", () => {
    expect(Object.keys(FIXTURES)).toEqual(RUN_OUTCOME_RULES.map((r) => r.id));
  });

  it.each(RUN_OUTCOME_RULES.map((rule, index) => [rule.id, rule.verdict, index] as const))(
    "%s → %s",
    (id, verdict, index) => {
      const fixture = FIXTURES[id];
      const m = meta(fixture.meta);
      const c = ctx(fixture.ctx);
      expect(MATCHES[id](m, c), `${id}'s fixture must match its own rule`).toBe(true);
      expect(firstMatch(m, c).id, `no earlier rule may match ${id}'s fixture`).toBe(id);
      expect(classifyRun(m, c).verdict ?? null).toBe(verdict);

      // The fixture would classify differently if a later rule came first.
      if (id !== "compare") {
        const later = RUN_OUTCOME_RULES.slice(index + 1).filter((r) => MATCHES[r.id](m, c));
        expect(
          later.some((r) => r.verdict !== verdict),
          `${id}'s fixture must also match a later rule with another verdict`,
        ).toBe(true);
      }
    },
  );

  it("agrees with classifyRun on every combination of the grid", () => {
    const statuses: IsolateMeta["status"][] = [null, "RE", "SG", "TO", "XX"];
    const times = [0.1, 1.0, 1.2];
    const memories: Array<[boolean, number | null]> = [
      [false, 10_000],
      [false, MEMORY_KB],
      [true, 60_000],
      [false, null],
    ];
    const signals = [null, 11, 25];
    const exits = [null, 0, 1, 3];
    const languages: LanguageKey[] = ["cpp20", "java21", "py312"];
    const stderrs = ["", 'Exception in thread "main" java.lang.OutOfMemoryError', "x\nMemoryError", "java.lang.StackOverflowError"];

    let checked = 0;
    const mismatches: string[] = [];
    for (const status of statuses)
      for (const timeSec of times)
        for (const [cgOomKilled, cgMemKb] of memories)
          for (const exitSignal of signals)
            for (const exitCode of exits)
              for (const outputLimitExceeded of [false, true])
                for (const language of languages)
                  for (const stderr of stderrs) {
                    const m = meta({ status, timeSec, cgOomKilled, cgMemKb, exitSignal, exitCode });
                    const c = ctx({ outputLimitExceeded, language, stderr });
                    const expected = firstMatch(m, c).verdict;
                    const actual = classifyRun(m, c).verdict ?? null;
                    checked++;
                    if (actual !== expected && mismatches.length < 10) {
                      mismatches.push(`${JSON.stringify({ m, c })}: classifyRun ${actual}, published ${expected}`);
                    }
                  }
    expect(mismatches).toEqual([]);
    expect(checked).toBe(5 * 3 * 4 * 3 * 4 * 2 * 3 * 4);
  });
});
