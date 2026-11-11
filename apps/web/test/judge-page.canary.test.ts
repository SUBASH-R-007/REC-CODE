import { describe, expect, it, vi } from "vitest";

/**
 * Proof that /judge DERIVES its values instead of copying them: LIMITS and
 * VERDICT_PRECEDENCE are replaced by sentinels no real configuration has,
 * and a canary LanguageConfig row carries a flag, multiplier, extra time,
 * version and environment variable that exist nowhere in the catalog. Every
 * sentinel must show on the page, and the precedence must follow the
 * replaced order. A hard-coded number anywhere would fail here.
 */

const SENTINEL = {
  memoryDefaultKb: 123_457,
  cpuCeilingMs: 14_321,
  outputFileKb: 54_321,
  extraTimeSec: 0.37,
  startupRuns: 17,
  maxDeviation: 0.07,
} as const;

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };

vi.mock("@recx/shared", async (importOriginal) => {
  const real = await importOriginal<typeof import("@recx/shared")>();
  const limits = structuredClone(real.LIMITS) as Mutable<typeof real.LIMITS>;
  limits.memory.defaultKb = SENTINEL.memoryDefaultKb;
  limits.cpuTime.ceilingMs = SENTINEL.cpuCeilingMs;
  limits.outputFile.defaultKb = SENTINEL.outputFileKb;
  limits.extraTimeSec = SENTINEL.extraTimeSec;
  limits.startupCredit.runs = SENTINEL.startupRuns;
  limits.calibration.maxDeviation = SENTINEL.maxDeviation;
  return { ...real, LIMITS: limits, VERDICT_PRECEDENCE: [...real.VERDICT_PRECEDENCE].reverse() };
});

const h = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("@/lib/db", () => ({ db: { languageConfig: { findMany: async () => h.rows } } }));
vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn, revalidateTag: vi.fn() }));

const shared = await import("@recx/shared");
const React = await import("react");
(globalThis as { React?: unknown }).React = React;
const { renderToStaticMarkup } = await import("react-dom/server");
const { default: JudgePage } = await import("@/app/(public)/judge/page");

const cpp20 = shared.LANGUAGE_CATALOG.cpp20;
const canaryRuntime = {
  ...cpp20,
  version: "99.9.9-canary",
  label: "C++20 (GCC 99.9.9-canary)",
  compile: { argv: [...(cpp20.compile?.argv ?? []), "-fcanary-flag"], slow: false },
  env: { ...cpp20.env, CANARY_ENV: "on" },
  fallbackMultiplier: 3.7,
  fallbackExtraMs: 432,
};
h.rows = [
  {
    key: "cpp20",
    label: canaryRuntime.label,
    version: canaryRuntime.version,
    toolchainId: cpp20.toolchainId,
    runtime: canaryRuntime,
  },
];

describe("/judge derives every value", () => {
  it("the sentinels are really in place", () => {
    expect(shared.LIMITS.memory.defaultKb).toBe(SENTINEL.memoryDefaultKb);
    expect(shared.VERDICT_PRECEDENCE[0]).toBe("AC");
  });

  it("shows every LIMITS sentinel, the canary row and the replaced precedence", async () => {
    const html = renderToStaticMarkup(await JudgePage()).replaceAll("<!-- -->", "");
    expect(html).toContain("123,457 KiB"); // memory.defaultKb
    expect(html).toContain("14.321 s"); // cpuTime.ceilingMs
    expect(html).toContain("54,321 KiB"); // outputFile.defaultKb
    expect(html).toContain("0.37 s"); // extraTimeSec
    expect(html).toContain("17 hello-world runs"); // startupCredit.runs (limits table)
    expect(html).toContain("17 times"); // startupCredit.runs (prose)
    expect(html).toContain("7% off the fleet median"); // calibration.maxDeviation

    const card = html.slice(html.indexOf('id="lang-cpp20"'), html.indexOf("</article>", html.indexOf('id="lang-cpp20"')));
    expect(card).toContain("-fcanary-flag");
    expect(card).toContain("CANARY_ENV=on");
    expect(card).toContain("99.9.9-canary");
    expect(card).toContain("×3.7");
    expect(card).toContain("+ 432 ms");
    // 1 s × 3.7 + 432 ms = 4,132 ms, rounded up to 4.2 s.
    expect(card).toContain("4.2 s");

    const precedence = html.slice(html.indexOf('id="verdict-precedence"'), html.indexOf("</ol>", html.indexOf('id="verdict-precedence"')));
    expect([...precedence.matchAll(/data-verdict="([^"]+)"/g)].map((m) => m[1])).toEqual([...shared.VERDICT_PRECEDENCE]);
  });
});
