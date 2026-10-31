import { LANGUAGE_KEYS, type LanguageKey } from "../languages";

/**
 * Which languages have a FUNCTION-mode harness, and which harness family
 * (code generator) each uses. Kept apart from the generators so the package
 * root can export it without pulling them in.
 *
 * Phase 4: C++ (cpp17, cpp20), Python (py312, pypy310) and Java (java21).
 * C, JavaScript, Go and Kotlin have no harness: a FUNCTION problem is simply
 * not offered in them (docs/OPEN-QUESTIONS.md, "Phase 4 — D1 harness").
 */
export type HarnessFamily = "cpp" | "python" | "java";

export const HARNESS_FAMILY: Readonly<Partial<Record<LanguageKey, HarnessFamily>>> = {
  cpp17: "cpp",
  cpp20: "cpp",
  py312: "python",
  pypy310: "python",
  java21: "java",
};

/** Every language with a FUNCTION harness, in LANGUAGE_KEYS order. */
export const FUNCTION_HARNESS_LANGUAGES: readonly LanguageKey[] = LANGUAGE_KEYS.filter(
  (key) => HARNESS_FAMILY[key] !== undefined,
);

export class HarnessUnsupportedError extends Error {}

export function harnessFamily(language: LanguageKey): HarnessFamily {
  const family = HARNESS_FAMILY[language];
  if (!family) {
    throw new HarnessUnsupportedError(`FUNCTION-mode problems are not available in ${language}.`);
  }
  return family;
}

export function supportsFunctionMode(language: LanguageKey): boolean {
  return HARNESS_FAMILY[language] !== undefined;
}
