import { describe, expect, it } from "vitest";
import {
  JVM_LANGUAGE_KEYS,
  LANGUAGE_CATALOG,
  LANGUAGE_KEYS,
  LIMITS,
  RUN_OUTCOME_RULES,
  SANDBOX_FORCED_ENV,
  VERDICT_PRECEDENCE,
  deriveTimeLimitMs,
  jvmRunFlags,
  wallTimeSecFor,
  type LanguageKey,
} from "@recx/shared";
import {
  EXAMPLE_BASE_MS,
  HEAP_EXAMPLES_KB,
  RUN_OUTCOME_TEXT,
  buildJudgeFacts,
  displayArgv,
  formatBytes,
  formatKib,
  formatMs,
  shellQuote,
  type PublicLanguageRow,
} from "@/lib/judge/transparency";

/**
 * The /judge view model (pure): quoting, units, ordering, availability,
 * the environment rule the sandbox applies, the time-limit example and the
 * rule that only ENFORCED limits are published.
 */

function row(key: LanguageKey, runtime: unknown = LANGUAGE_CATALOG[key]): PublicLanguageRow {
  const rt = LANGUAGE_CATALOG[key];
  return { key, label: rt.label, version: rt.version, toolchainId: rt.toolchainId, runtime };
}

/** A minimal POSIX word splitter: single quotes, backslash escapes outside quotes, blanks. */
function shellSplit(line: string): string[] {
  const words: string[] = [];
  let word: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (ch === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) throw new Error("unterminated quote");
      word = (word ?? "") + line.slice(i + 1, end);
      i = end;
    } else if (ch === "\\") {
      word = (word ?? "") + (line[i + 1] ?? "");
      i++;
    } else if (ch === " ") {
      if (word !== null) words.push(word);
      word = null;
    } else {
      word = (word ?? "") + ch;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

describe("displayArgv", () => {
  it("quotes only the arguments that need it", () => {
    expect(shellQuote("-O2")).toBe("-O2");
    expect(shellQuote("/opt/toolchains/temurin-21.0.4+7/bin/java")).toBe("/opt/toolchains/temurin-21.0.4+7/bin/java");
    expect(shellQuote("-XX:SharedArchiveFile=/opt/x.jsa")).toBe("-XX:SharedArchiveFile=/opt/x.jsa");
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("")).toBe("''");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it.each(LANGUAGE_KEYS.flatMap((key) => {
    const rt = LANGUAGE_CATALOG[key];
    return [[`${key} run`, rt.run.argv], ...(rt.compile ? [[`${key} compile`, rt.compile.argv]] : [])] as Array<[string, string[]]>;
  }))("%s round-trips through a shell", (_name, argv) => {
    expect(shellSplit(displayArgv(argv))).toEqual(argv);
  });

  it("round-trips the py312 syntax-check snippet (quotes inside)", () => {
    const argv = LANGUAGE_CATALOG.py312.compile?.argv ?? [];
    expect(argv.some((a) => a.includes("'"))).toBe(true);
    expect(shellSplit(displayArgv(argv))).toEqual(argv);
  });
});

describe("units", () => {
  it("formatKib shows the binary unit and the exact KiB", () => {
    expect(formatKib(262_144)).toBe("256 MiB (262,144 KiB)");
    expect(formatKib(1_048_576)).toBe("1 GiB (1,048,576 KiB)");
    expect(formatKib(65_536)).toBe("64 MiB (65,536 KiB)");
    expect(formatKib(123_457)).toBe("120.6 MiB (123,457 KiB)");
    expect(formatKib(512)).toBe("512 KiB");
  });

  it("formatBytes is exact", () => {
    expect(formatBytes(64 * 1024 * 1024)).toBe("64 MiB");
    expect(formatBytes(8 * 1024)).toBe("8 KiB");
    expect(formatBytes(1000)).toBe("1,000 bytes");
  });

  it("formatMs", () => {
    expect(formatMs(1500)).toBe("1.5 s");
    expect(formatMs(15_000)).toBe("15 s");
    expect(formatMs(300)).toBe("300 ms");
  });
});

describe("buildJudgeFacts: languages", () => {
  it("orders by LANGUAGE_KEYS and keeps one row per key (the first)", () => {
    const facts = buildJudgeFacts([
      row("py312"),
      row("java21"),
      { ...row("cpp20"), label: "first cpp20" },
      { ...row("cpp20"), label: "second cpp20" },
      row("c17"),
    ]);
    expect(facts.languages.map((l) => l.key)).toEqual(["c17", "cpp20", "java21", "py312"]);
    expect(facts.languages.find((l) => l.key === "cpp20")?.label).toBe("first cpp20");
  });

  it("marks a row unavailable when its runtime does not parse or names another language", () => {
    const facts = buildJudgeFacts([
      row("cpp20", { not: "a runtime" }),
      row("py312", LANGUAGE_CATALOG.pypy310),
      row("java21"),
    ]);
    const by = new Map(facts.languages.map((l) => [l.key, l]));
    for (const key of ["cpp20", "py312"]) {
      expect(by.get(key)).toMatchObject({ available: false, compile: null, run: null, env: [], fallback: null });
    }
    expect(by.get("java21")?.available).toBe(true);
    expect(by.get("cpp20")?.anchor).toBe("lang-cpp20");
  });

  it.each(LANGUAGE_KEYS.map((k) => [k]))("%s: commands, caps, limits and the worked example come from the runtime", (key) => {
    const rt = LANGUAGE_CATALOG[key];
    const [fact] = buildJudgeFacts([row(key)]).languages;
    expect(fact).toBeDefined();
    if (!fact) return;
    expect(fact.available).toBe(true);
    expect(fact.anchor).toBe(`lang-${key}`);
    expect(fact.run).toBe(displayArgv(rt.run.argv));
    if (rt.compile) {
      expect(fact.compile).toEqual({
        command: displayArgv(rt.compile.argv),
        cpuSec: rt.compile.slow ? LIMITS.compile.cpuSecSlow : LIMITS.compile.cpuSec,
        wallSec: rt.compile.slow ? LIMITS.compile.wallSecSlow : LIMITS.compile.wallSec,
        slow: rt.compile.slow,
      });
    } else {
      expect(fact.compile).toBeNull();
    }
    expect(fact.processes).toBe(rt.processes);
    expect(fact.openFiles).toBe(rt.openFiles);
    expect(fact.managed).toBe(rt.family === "managed");
    expect(fact.toolchains).toEqual([rt.toolchainId, ...rt.extraToolchainIds].map((id) => `/opt/toolchains/${id}`));
    expect(fact.jvmFlags).toEqual(
      JVM_LANGUAGE_KEYS.includes(key)
        ? HEAP_EXAMPLES_KB.map((memoryKb) => ({ memoryKb, flags: displayArgv(jvmRunFlags(memoryKb)) }))
        : null,
    );
    expect(fact.fallback).toEqual({
      multiplier: rt.fallbackMultiplier,
      extraMs: rt.fallbackExtraMs,
      exampleMs: deriveTimeLimitMs({
        baseMs: EXAMPLE_BASE_MS,
        measuredModelMs: null,
        multiplier: rt.fallbackMultiplier,
        extraMs: rt.fallbackExtraMs,
      }),
    });
  });

  it("uses the slow-compiler caps exactly when compile.slow is set", () => {
    const kotlin = buildJudgeFacts([row("kotlin20")]).languages[0];
    expect(LANGUAGE_CATALOG.kotlin20.compile?.slow).toBe(true);
    expect(kotlin?.compile).toMatchObject({ cpuSec: LIMITS.compile.cpuSecSlow, wallSec: LIMITS.compile.wallSecSlow });
  });

  it("reads the runtime JSON, not the catalog (a changed multiplier shows)", () => {
    const runtime = { ...LANGUAGE_CATALOG.cpp20, fallbackMultiplier: 1.7, fallbackExtraMs: 40 };
    const [fact] = buildJudgeFacts([row("cpp20", runtime)]).languages;
    expect(fact?.fallback?.multiplier).toBe(1.7);
    expect(fact?.fallback?.exampleMs).toBe(deriveTimeLimitMs({ baseMs: EXAMPLE_BASE_MS, measuredModelMs: null, multiplier: 1.7, extraMs: 40 }));
  });

  it("environment: the language's variables, then the sandbox's forced ones, never duplicated", () => {
    const runtime = { ...LANGUAGE_CATALOG.py312, env: { ...LANGUAGE_CATALOG.py312.env, HOME: "/tmp", LANG: "en_GB" } };
    const [fact] = buildJudgeFacts([row("py312", runtime)]).languages;
    const env = fact?.env ?? [];
    const forced = Object.entries(SANDBOX_FORCED_ENV);
    expect(env.slice(-forced.length)).toEqual(forced);
    expect(env.filter(([k]) => k === "HOME")).toEqual([["HOME", "/box"]]);
    expect(env.filter(([k]) => k === "LANG")).toEqual([["LANG", "C.UTF-8"]]);
    expect(env.slice(0, -forced.length)).toEqual(Object.entries(LANGUAGE_CATALOG.py312.env));
  });
});

describe("buildJudgeFacts: limits, timing and rules", () => {
  const facts = buildJudgeFacts([]);

  it("publishes only enforced limits: no inode count", () => {
    expect(LIMITS.scratchDisk.inodes).toBeGreaterThan(0);
    const text = JSON.stringify(facts.limits);
    expect(text).not.toMatch(/inode/i);
    expect(text).not.toContain(LIMITS.scratchDisk.inodes.toLocaleString("en-US"));
    expect(text).not.toContain(String(LIMITS.scratchDisk.inodes));
  });

  it("publishes the start-up credit cap (claim.ts enforces it)", () => {
    const startup = facts.limits.find((l) => l.id === "startup-credit");
    expect(startup?.value).toContain(formatMs(LIMITS.startupCredit.maxMs));
    expect(startup?.value).toContain(`${LIMITS.startupCredit.runs} hello-world runs`);
  });

  it("has unique limit ids and a value for each", () => {
    const ids = facts.limits.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const limit of facts.limits) expect(limit.value.length).toBeGreaterThan(0);
  });

  it("states the headline numbers from LIMITS", () => {
    const by = new Map(facts.limits.map((l) => [l.id, l.value]));
    expect(by.get("cpu")).toContain(formatMs(LIMITS.cpuTime.floorMs));
    expect(by.get("cpu")).toContain(formatMs(LIMITS.cpuTime.ceilingMs));
    expect(by.get("extra")).toContain(`${LIMITS.extraTimeSec} s`);
    expect(by.get("memory")).toContain(formatKib(LIMITS.memory.defaultKb));
    expect(by.get("memory")).toContain(formatKib(LIMITS.memory.ceilingKb));
    expect(by.get("file-size")).toBe(formatKib(LIMITS.outputFile.defaultKb));
    expect(by.get("source")).toBe(formatBytes(LIMITS.source.defaultBytes));
    expect(by.get("stderr")).toBe(formatBytes(LIMITS.stderrCapture.defaultBytes));
  });

  it("timing derives the wall-clock examples and the flip margin", () => {
    expect(facts.timing.wall).toEqual([
      { cpuMs: 1000, wallSec: wallTimeSecFor(1000) },
      { cpuMs: 2000, wallSec: wallTimeSecFor(2000) },
    ]);
    expect(facts.timing.flipMarginPct).toBe(Math.round(LIMITS.calibration.maxDeviation * 100));
    expect(facts.timing.modelMultiplier).toBe(LIMITS.timeLimit.modelMultiplier);
    expect(facts.timing.startupMaxMs).toBe(LIMITS.startupCredit.maxMs);
  });

  it("lists the outcome rules in the published order, each with prose", () => {
    expect(facts.outcomeRules.map((r) => [r.id, r.verdict])).toEqual(RUN_OUTCOME_RULES.map((r) => [r.id, r.verdict]));
    for (const rule of facts.outcomeRules) expect(rule.text).toBe(RUN_OUTCOME_TEXT[rule.id]);
    expect(Object.keys(RUN_OUTCOME_TEXT).sort()).toEqual(RUN_OUTCOME_RULES.map((r) => r.id).sort());
  });

  it("publishes VERDICT_PRECEDENCE as is", () => {
    expect(facts.precedence).toEqual(VERDICT_PRECEDENCE);
  });
});
