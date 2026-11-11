import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  deriveTimeLimitMs,
  isLanguageKey,
  LANGUAGE_CATALOG,
  LANGUAGE_KEYS,
  TESTLIB_ID,
  TOOLCHAIN_ROOT,
  toolchainDirs,
  type FunctionSignature,
  type JudgeJobSpec,
  type LanguageKey,
  type ResultRequest,
  type Verdict,
} from "@recx/shared";
import { validationOutcome } from "@recx/shared/harness";
import { generateTwoSumTests, TWO_SUM, TWO_SUM_REFERENCE } from "@recx/shared/samples/two-sum";
import { AUTHORED_PROBLEMS } from "../../../web/scripts/content/index";
import { BlobCache } from "../../src/cache";
import { CompileCache } from "../../src/compile-cache";
import { IsolateDriver } from "../../src/drivers/isolate";
import { createLogger } from "../../src/logger";
import { processJob, type ProcessorDeps } from "../../src/processor";
import { MemoryPublisher } from "../../src/publisher";
import { SlotPool } from "../../src/slots";
import { FakeJudgeApi } from "../support/fake-api";
import { buildJob } from "../support/jobs";

/**
 * The Phase 4 golden gate: every seeded problem's reference solutions,
 * judged on REAL isolate boxes with the pinned toolchains through the
 * worker's own job path (claim → blobs → IsolateDriver → result).
 *
 *   problems   two-sum plus every AUTHORED_PROBLEMS entry (imported by
 *              relative path from apps/web/scripts/content — pure data,
 *              enforced by tests/repo/content-purity.test.ts)
 *   languages  every catalog language with enabledByDefault (cpp20, py312)
 *              plus RECX_GOLDEN_EXTRA_LANGUAGES (linux-gate.sh: java21)
 *   solutions  every reference solution in those languages
 *
 * Model solutions (expected AC) must pass EVERY test; deliberately-wrong
 * ones must produce their expected verdict (validationOutcome MATCHED).
 * Time limits are the student-facing fallback limits (deriveTimeLimitMs with
 * the language's multiplier, no measurement), memory the problem's own.
 * A missing toolchain or testlib for an enabled or extra language FAILS the
 * gate, and every (problem, enabled language) pair must have a model
 * solution — the gate can never pass by having nothing to judge.
 *
 * Box base 70 (run 70, compile 170, checker 270): clear of the live worker
 * (0–7, 100–107, 200–207, maintenance 900+) and of the other isolate suites
 * (40, 50, 60, 80, 90).
 *
 *   cd ~/recx/apps/judge-worker && RECX_ISOLATE_INTEGRATION=1 RECX_GOLDEN_EXTRA_LANGUAGES=java21 \
 *     RECX_CACHE_DIR=/tmp/recjudge-cache npx vitest run --config vitest.integration.config.ts golden
 */

const enabled = process.platform === "linux" && process.env.RECX_ISOLATE_INTEGRATION === "1";
const BOX_BASE = Number(process.env.RECX_GOLDEN_BOX_BASE ?? 70);

const ENABLED_LANGUAGES: LanguageKey[] = LANGUAGE_KEYS.filter((k) => LANGUAGE_CATALOG[k].enabledByDefault);
const EXTRA_LANGUAGES: LanguageKey[] = (process.env.RECX_GOLDEN_EXTRA_LANGUAGES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0)
  .map((s) => {
    if (!isLanguageKey(s)) throw new Error(`RECX_GOLDEN_EXTRA_LANGUAGES: unknown language ${s}`);
    return s;
  });
const GOLDEN_LANGUAGES: LanguageKey[] = [...new Set([...ENABLED_LANGUAGES, ...EXTRA_LANGUAGES])];

interface GoldenReference {
  language: LanguageKey;
  label: string;
  expected: Verdict;
  source: string;
}

interface GoldenProblem {
  slug: string;
  ioMode: "STDIN" | "FUNCTION";
  signature: FunctionSignature | null;
  compareMode: JudgeJobSpec["compareMode"];
  scoringMode: JudgeJobSpec["scoringMode"];
  timeLimitMs: number;
  memoryLimitKb: number;
  checkerSource: string | null;
  subtasks: JudgeJobSpec["subtasks"];
  tests: { input: string; output: string; isSample: boolean; subtask: number | null }[];
  references: GoldenReference[];
}

const PROBLEMS: GoldenProblem[] = [
  {
    slug: TWO_SUM.slug,
    ioMode: "FUNCTION",
    signature: TWO_SUM.signature,
    compareMode: "TOKEN",
    scoringMode: "ICPC",
    timeLimitMs: TWO_SUM.timeLimitMs,
    memoryLimitKb: TWO_SUM.memoryLimitKb,
    checkerSource: null,
    subtasks: [],
    tests: generateTwoSumTests().map((t) => ({ input: t.input, output: t.output, isSample: t.isSample, subtask: null })),
    references: Object.entries(TWO_SUM_REFERENCE).flatMap(([language, entries]) =>
      (entries ?? []).map((e, i) => ({ language: language as LanguageKey, label: `${e.expected} ${i + 1}`, expected: e.expected, source: e.source })),
    ),
  },
  ...AUTHORED_PROBLEMS.map(
    (p): GoldenProblem => ({
      slug: p.slug,
      ioMode: p.ioMode,
      signature: p.signature,
      compareMode: p.compareMode,
      scoringMode: p.scoringMode,
      timeLimitMs: p.timeLimitMs,
      memoryLimitKb: p.memoryLimitKb,
      checkerSource: p.checkerSource,
      subtasks: p.subtasks.map((s) => ({ index: s.index, points: s.points, aggregation: "MIN" as const, dependsOn: s.dependsOn })),
      tests: p.generateTests().map((t) => ({ input: t.input, output: t.output, isSample: t.isSample, subtask: t.subtask })),
      references: p.references.map((r) => ({ language: r.language, label: r.label, expected: r.expected, source: r.source })),
    }),
  ),
];

const CASES = PROBLEMS.flatMap((problem) =>
  problem.references
    .filter((r) => GOLDEN_LANGUAGES.includes(r.language))
    .map((reference) => ({ problem, reference, name: `${problem.slug} · ${reference.language} · ${reference.label} → ${reference.expected}` })),
);

function goldenJob(problem: GoldenProblem, reference: GoldenReference) {
  const runtime = LANGUAGE_CATALOG[reference.language];
  return buildJob({
    kind: "validation",
    lane: "REJUDGE",
    language: reference.language,
    source: reference.source,
    ioMode: problem.ioMode,
    functionSignature: problem.signature,
    compareMode: problem.compareMode,
    floatEpsilon: null,
    scoringMode: problem.scoringMode,
    // A model solution runs every test; a deliberately-wrong one may stop at its first failure.
    stopOnFirstFailure: reference.expected !== "AC",
    timeLimitMs: deriveTimeLimitMs({
      baseMs: problem.timeLimitMs,
      measuredModelMs: null,
      multiplier: runtime.fallbackMultiplier,
      extraMs: runtime.fallbackExtraMs,
    }),
    memoryLimitKb: problem.memoryLimitKb,
    subtasks: problem.subtasks,
    cases: problem.tests.map((t) => ({ input: t.input, output: t.output, isSample: t.isSample, subtask: t.subtask })),
    ...(problem.checkerSource !== null ? { checkerSource: problem.checkerSource, testlibId: TESTLIB_ID } : {}),
  });
}

describe("golden gate — what it covers", () => {
  it("covers two-sum and every authored problem", () => {
    expect(PROBLEMS.map((p) => p.slug)).toEqual([TWO_SUM.slug, ...AUTHORED_PROBLEMS.map((p) => p.slug)]);
  });

  it("has a model solution for every (problem, enabled language) pair", () => {
    for (const problem of PROBLEMS) {
      for (const language of ENABLED_LANGUAGES) {
        const model = problem.references.some((r) => r.language === language && r.expected === "AC");
        expect(model, `${problem.slug} has no ${language} model solution`).toBe(true);
      }
    }
  });

  it("judges at least one reference per golden language", () => {
    for (const language of GOLDEN_LANGUAGES) {
      expect(CASES.some((c) => c.reference.language === language), language).toBe(true);
    }
  });
});

describe.skipIf(!enabled)("golden gate on real isolate", () => {
  let deps: ProcessorDeps;
  let api: FakeJudgeApi;
  const summary: string[] = [];

  beforeAll(async () => {
    const logger = createLogger({ level: process.env.LOG_LEVEL ?? "warn", nodeId: "golden" });
    api = new FakeJudgeApi();
    const compileCache = new CompileCache({ dir: mkdtempSync(path.join(os.tmpdir(), "recjudge-golden-cc-")), logger });
    const driver = await IsolateDriver.create({
      isolateBin: process.env.RECX_ISOLATE_BIN ?? "isolate",
      boxBase: BOX_BASE,
      syntheticEtc: process.env.RECX_SYNTHETIC_ETC ?? "/var/lib/recjudge/etc",
      logger,
      compileCache,
    });
    const cacheDir = process.env.RECX_CACHE_DIR ?? mkdtempSync(path.join(os.tmpdir(), "recjudge-cache-"));
    deps = {
      api,
      driver,
      cache: new BlobCache({ dir: cacheDir, maxBytes: 1024 * 1024 * 1024, logger }),
      publisher: new MemoryPublisher(),
      slots: new SlotPool(1),
      logger,
      nodeId: "golden",
    };
    const info = await driver.info();
    console.log(
      `[golden] box base ${BOX_BASE}; isolate ${info.version}; languages ${GOLDEN_LANGUAGES.join(", ")} ` +
        `(host has ${info.languages.join(", ")}); ${CASES.length} reference solutions`,
    );
  }, 300_000);

  it("finds every golden language's toolchains, and testlib, on this host (missing = FAIL, never skip)", () => {
    for (const language of GOLDEN_LANGUAGES) {
      for (const dir of toolchainDirs(LANGUAGE_CATALOG[language])) {
        expect(existsSync(dir), `${language}: ${dir} is missing`).toBe(true);
      }
    }
    if (PROBLEMS.some((p) => p.checkerSource !== null)) {
      expect(existsSync(`${TOOLCHAIN_ROOT}/${TESTLIB_ID}/testlib.h`), `${TESTLIB_ID}/testlib.h is missing`).toBe(true);
    }
  });

  it.each(CASES.map((c) => [c.name, c] as const))("%s", async (_name, { problem, reference }) => {
    const job = goldenJob(problem, reference);
    api.add(job.spec, job.blobs);
    const started = Date.now();
    const outcome = await processJob({ kind: job.spec.kind, id: job.spec.id }, deps);
    const result: ResultRequest | undefined = api.results.find((r) => r.id === job.spec.id);
    const release = api.releases.find((r) => r.id === job.spec.id);
    const line =
      `${problem.slug} ${reference.language} "${reference.label}": ` +
      (result
        ? `${result.verdict} ${result.passedCases}/${result.totalCases} maxTime=${result.maxTimeMs}ms (limit ${job.spec.timeLimitMs}) ` +
          `maxMem=${result.maxMemoryKb}KB compile=${result.compile ? `${result.compile.ok ? "ok" : "CE"} ${result.compile.timeMs}ms` : "none"}`
        : `NO RESULT (${outcome.outcome}${release ? `: ${release.reason}` : ""})`) +
      ` wall=${Date.now() - started}ms`;
    summary.push(line);
    console.log(`[golden] ${line}`);
    if (result?.compile && !result.compile.ok) console.log(`[golden] compile output:\n${result.compile.output}`);

    expect(outcome.outcome, release?.reason ?? "").toBe("posted");
    expect(result).toBeDefined();
    if (reference.expected === "AC") {
      expect(result!.verdict, line).toBe("AC");
      expect(result!.passedCases, line).toBe(problem.tests.length);
      expect(result!.tests.every((t) => t.v === "AC"), line).toBe(true);
    } else {
      expect(validationOutcome(reference.expected, result!.verdict, result!.tests), line).toBe("MATCHED");
    }
  });

  it("prints the summary", () => {
    console.log(`[golden] summary (${summary.length} judged):\n${summary.join("\n")}`);
    expect(summary.length).toBe(CASES.length);
  });
});
