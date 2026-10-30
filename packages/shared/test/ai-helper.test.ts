import { describe, expect, it } from "vitest";
import {
  AI_DAILY_LIMIT,
  AI_HELPER_DEFAULT,
  AI_MODELS,
  AI_MODEL_IDS,
  AI_OUTPUT_MAX_TOKENS,
  AI_REFUSALS,
  AI_SOURCE_MAX_CHARS,
  AI_STATEMENT_MAX_CHARS,
  AI_SYSTEM_PROMPT,
  HELP_CONTEXTS,
  HINT_POLICY,
  aiHelperAccess,
  aiHelperSettingSchema,
  aiModel,
  buildAiPrompt,
  clipForModel,
  effectiveAiHelperSetting,
  makesSolveAssisted,
  type AiAskKind,
  type HelpContext,
} from "../src/index";

const NOW = new Date("2026-10-30T10:00:00.000Z");

function input(over: Partial<Parameters<typeof aiHelperAccess>[0]> = {}) {
  return {
    context: "PRACTICE" as HelpContext,
    attempts: 1,
    failedAttempts: 1,
    activeSeconds: 0,
    solved: false,
    editorialVisibleAt: null,
    now: NOW,
    enabled: true,
    askedToday: 0,
    dailyPerStudent: 10,
    ...over,
  };
}

describe("the setting", () => {
  it("defaults to off, and so does anything unreadable", () => {
    expect(AI_HELPER_DEFAULT.enabled).toBe(false);
    for (const value of [undefined, null, {}, 42, "on", { enabled: true }, { ...AI_HELPER_DEFAULT, modelId: "gpt-x" }]) {
      expect(effectiveAiHelperSetting(value)).toEqual(AI_HELPER_DEFAULT);
    }
  });

  it("round-trips a valid value", () => {
    const value = { enabled: true, modelId: "claude-haiku-5-5", dailyPerStudent: 3, maxOutputTokens: 400 };
    expect(effectiveAiHelperSetting(value)).toEqual(value);
  });

  it("refuses an unknown key, an unknown model and a cap out of range", () => {
    const base = { enabled: true, modelId: "claude-sonnet-5-5", dailyPerStudent: 5, maxOutputTokens: 700 };
    expect(aiHelperSettingSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(aiHelperSettingSchema.safeParse({ ...base, modelId: "../../etc/passwd" }).success).toBe(false);
    expect(aiHelperSettingSchema.safeParse({ ...base, dailyPerStudent: AI_DAILY_LIMIT.max + 1 }).success).toBe(false);
    expect(aiHelperSettingSchema.safeParse({ ...base, dailyPerStudent: 0 }).success).toBe(false);
    expect(aiHelperSettingSchema.safeParse({ ...base, maxOutputTokens: AI_OUTPUT_MAX_TOKENS.max + 1 }).success).toBe(false);
    expect(aiHelperSettingSchema.safeParse({ ...base, dailyPerStudent: 2.5 }).success).toBe(false);
  });

  it("the catalogue is closed, unique, and the default model is in it", () => {
    expect(new Set(AI_MODEL_IDS).size).toBe(AI_MODELS.length);
    expect(AI_MODEL_IDS).toContain(AI_HELPER_DEFAULT.modelId);
    expect(aiModel("claude-opus-5-5")?.provider).toBe("anthropic");
    expect(aiModel("custom")?.provider).toBe("openai-compatible");
    expect(aiModel("nope")).toBeNull();
  });
});

describe("who may ask", () => {
  it("nobody, when it is switched off — whatever else is true", () => {
    for (const context of HELP_CONTEXTS) {
      const access = aiHelperAccess(input({ enabled: false, context, attempts: 99, solved: true }));
      expect(access).toEqual({ allowed: false, reason: AI_REFUSALS.off, marksAssisted: false });
    }
  });

  it("nobody in a contest or an assessment, however hard they have worked", () => {
    for (const context of ["CONTEST", "ASSESSMENT"] as const) {
      for (const over of [{}, { attempts: 50, failedAttempts: 50 }, { activeSeconds: 100_000 }, { solved: true }]) {
        const access = aiHelperAccess(input({ context, ...over }));
        expect(access.allowed, context).toBe(false);
        expect(access.reason).toBe(AI_REFUSALS.notPractice);
        expect(access.marksAssisted).toBe(false);
      }
    }
  });

  it("not before a real go: no attempts and under hint 2's minutes", () => {
    const tooEarly = aiHelperAccess(input({ attempts: 0, failedAttempts: 0, activeSeconds: 0 }));
    expect(tooEarly).toEqual({ allowed: false, reason: AI_REFUSALS.tooEarly, marksAssisted: false });

    const justUnder = aiHelperAccess(
      input({ attempts: 0, failedAttempts: 0, activeSeconds: HINT_POLICY.tier2.activeMinutes * 60 - 1 }),
    );
    expect(justUnder.allowed).toBe(false);
  });

  it("unlocks on one judged submission, or on hint 2's minutes", () => {
    expect(aiHelperAccess(input({ attempts: 1, activeSeconds: 0 })).allowed).toBe(true);
    expect(
      aiHelperAccess(input({ attempts: 0, failedAttempts: 0, activeSeconds: HINT_POLICY.tier2.activeMinutes * 60 }))
        .allowed,
    ).toBe(true);
  });

  it("a compile error counts as a go (attempts, not failedAttempts)", () => {
    expect(aiHelperAccess(input({ attempts: 1, failedAttempts: 0, activeSeconds: 0 })).allowed).toBe(true);
  });

  it("a solved problem may be asked about straight away, and the answer taints nothing", () => {
    const access = aiHelperAccess(input({ attempts: 0, failedAttempts: 0, activeSeconds: 0, solved: true }));
    expect(access.allowed).toBe(true);
    expect(access.marksAssisted).toBe(false);
  });

  it("an unsolved problem's answer makes the first solve assisted", () => {
    expect(aiHelperAccess(input()).marksAssisted).toBe(true);
  });

  it("stops at the daily allowance, and the allowance is the only thing that stops it", () => {
    expect(aiHelperAccess(input({ askedToday: 9, dailyPerStudent: 10 })).allowed).toBe(true);
    const spent = aiHelperAccess(input({ askedToday: 10, dailyPerStudent: 10 }));
    expect(spent).toEqual({ allowed: false, reason: AI_REFUSALS.dailyLimit, marksAssisted: false });
    // Over, not merely at: a cap that was lowered since must still refuse.
    expect(aiHelperAccess(input({ askedToday: 40, dailyPerStudent: 10 })).allowed).toBe(false);
  });

  it("refuses in a fixed order: off, then the wrong surface, then effort, then the cap", () => {
    expect(aiHelperAccess(input({ enabled: false, context: "CONTEST" })).reason).toBe(AI_REFUSALS.off);
    expect(aiHelperAccess(input({ context: "CONTEST", attempts: 0, askedToday: 99 })).reason).toBe(
      AI_REFUSALS.notPractice,
    );
    expect(aiHelperAccess(input({ attempts: 0, failedAttempts: 0, askedToday: 99 })).reason).toBe(AI_REFUSALS.tooEarly);
  });

  it("every refusal is a sentence a student can act on", () => {
    for (const [key, text] of Object.entries(AI_REFUSALS)) {
      expect(text.length, key).toBeGreaterThan(20);
      expect(text.trim(), key).toMatch(/[.!]$/);
    }
  });
});

describe("the assisted rule", () => {
  it("an AI answer counts, like the editorial and unlike hints 1 and 2", () => {
    expect(makesSolveAssisted({ ai: true })).toBe(true);
    expect(makesSolveAssisted({ editorial: true })).toBe(true);
    expect(makesSolveAssisted({ hintTier: 3 })).toBe(true);
    expect(makesSolveAssisted({ hintTier: 2 })).toBe(false);
    expect(makesSolveAssisted({ hintTier: 1 })).toBe(false);
  });
});

describe("what the model is told", () => {
  const material = {
    problemTitle: "Two Sum",
    statement: "Given an array, return two indices.",
    language: "cpp20",
    source: "int main() { return 0; }",
    lastVerdict: "WA",
    failedSample: { input: "1 2", expected: "3", got: "4" },
  };

  it("sends the statement, the draft, the verdict and the sample it failed", () => {
    const prompt = buildAiPrompt({ kind: "MISTAKE", ...material });
    expect(prompt).toContain("Two Sum");
    expect(prompt).toContain("Given an array");
    expect(prompt).toContain("int main()");
    expect(prompt).toContain("cpp20");
    expect(prompt).toContain("WA");
    expect(prompt).toContain("expected: 3");
  });

  it("says nothing about who the student is", () => {
    const prompt = buildAiPrompt({ kind: "APPROACH", ...material });
    for (const leak of ["@rajalakshmi", "userId", "roll", "register number", "cuid"]) {
      expect(prompt.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });

  it("asks a different question for each kind", () => {
    const mistake = buildAiPrompt({ kind: "MISTAKE", ...material });
    const approach = buildAiPrompt({ kind: "APPROACH", ...material });
    expect(mistake).toContain("what is wrong with my code?");
    expect(mistake).toContain("Do not rewrite their program.");
    expect(approach).toContain("how should I approach this?");
    expect(approach).toContain("Do not write the solution.");
    expect(mistake).not.toBe(approach);
  });

  it("omits the verdict and the sample when there is none", () => {
    const prompt = buildAiPrompt({ kind: "MISTAKE", ...material, lastVerdict: null, failedSample: null });
    expect(prompt).not.toContain("Their last judged submission");
    expect(prompt).not.toContain("A sample case they failed");
  });

  it("says so plainly when nothing has been written", () => {
    const prompt = buildAiPrompt({ kind: "APPROACH", ...material, source: "" });
    expect(prompt).toContain("(they have written nothing yet)");
  });

  it("is bounded: a huge draft and a huge statement are clipped", () => {
    const prompt = buildAiPrompt({
      kind: "MISTAKE",
      ...material,
      statement: "s\n".repeat(AI_STATEMENT_MAX_CHARS),
      source: "x\n".repeat(AI_SOURCE_MAX_CHARS),
    });
    expect(prompt.length).toBeLessThan(AI_STATEMENT_MAX_CHARS + AI_SOURCE_MAX_CHARS + 4_000);
    expect(prompt).toContain("… (truncated)");
  });

  it("clips on a line boundary when there is one", () => {
    expect(clipForModel("abc", 10)).toBe("abc");
    const clipped = clipForModel("aaaa\nbbbb\ncccc", 11);
    expect(clipped).toBe("aaaa\nbbbb\n… (truncated)");
    // No usable boundary: cut where the budget runs out rather than keep a stub.
    expect(clipForModel("aaaaaaaaaa\nb", 6)).toBe("aaaaaa\n… (truncated)");
  });

  it("the system prompt forbids a finished solution and says nothing about hidden tests", () => {
    expect(AI_SYSTEM_PROMPT).toContain("NEVER write a complete solution");
    expect(AI_SYSTEM_PROMPT).toContain("not given the hidden tests");
  });

  it("every ask kind has a label a student would recognise", () => {
    const kinds: AiAskKind[] = ["MISTAKE", "APPROACH"];
    for (const kind of kinds) expect(buildAiPrompt({ kind, ...material })).toMatch(/They asked: /);
  });
});
