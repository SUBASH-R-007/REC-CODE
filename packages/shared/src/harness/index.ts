import type { LanguageKey } from "../languages";
import { cppDriver, cppPrelude, cppStub } from "./cpp";
import { FUNCTION_HARNESS_LANGUAGES, harnessFamily, type HarnessFamily } from "./family";
import { javaDriver, javaPrelude, javaStub } from "./java";
import { pythonDriver, pythonPrelude, pythonStub } from "./python";
import type { HarnessBuild } from "./remap";
import type { FunctionSignature } from "./signature";

export * from "./signature";
export * from "./values";
export * from "./family";
export * from "./compare";
export * from "./declaration";
export * from "./remap";
export * from "./outcome";
export { checkerTemplate } from "./checker-template";
export { cppType, cppReaderKit } from "./cpp";
export { javaType } from "./java";

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

const GENERATORS: Record<
  HarnessFamily,
  { prelude: (sig: FunctionSignature) => string; driver: (sig: FunctionSignature) => string; stub: (sig: FunctionSignature) => string; displayName: string }
> = {
  cpp: { prelude: cppPrelude, driver: cppDriver, stub: cppStub, displayName: "solution.cpp" },
  python: { prelude: pythonPrelude, driver: pythonDriver, stub: pythonStub, displayName: "solution.py" },
  java: { prelude: javaPrelude, driver: javaDriver, stub: javaStub, displayName: "Solution.java" },
};

/**
 * Wrap student code in the prelude and driver for its language. The student
 * code is placed verbatim (normalised to end with a newline) so line numbers
 * inside it shift by exactly the prelude length — see remapDiagnostics().
 */
export function buildHarness(language: LanguageKey, sig: FunctionSignature, userSource: string): HarnessBuild {
  const family = harnessFamily(language);
  const gen = GENERATORS[family];
  const user = userSource.replace(/\r\n?/g, "\n");
  const body = user.endsWith("\n") ? user : user + "\n";
  const prelude = gen.prelude(sig);
  return {
    source: prelude + body + gen.driver(sig),
    userStartLine: lineCount(prelude) + 1,
    userLineCount: lineCount(body),
    displayName: gen.displayName,
    family,
  };
}

export function starterStub(language: LanguageKey, sig: FunctionSignature): string {
  return GENERATORS[harnessFamily(language)].stub(sig);
}

/** Starter stubs for every language with a FUNCTION harness (authoring's "scaffold from signature"). */
export function starterStubs(sig: FunctionSignature): Partial<Record<LanguageKey, string>> {
  const out: Partial<Record<LanguageKey, string>> = {};
  for (const language of FUNCTION_HARNESS_LANGUAGES) out[language] = starterStub(language, sig);
  return out;
}
