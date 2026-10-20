/**
 * Shapes shared by the seed's content modules. Everything under
 * scripts/content is ORIGINALLY AUTHORED for REC Code — statements, tests,
 * hints, editorials and solutions — and nothing in it is copied or
 * paraphrased from another judge or tutorial site.
 *
 * The modules are pure data plus deterministic generators: no database, no
 * environment, no server-only imports, so unit tests import them directly.
 */
import type { FunctionSignature, LanguageKey, Topic, Verdict } from "@recx/shared";

export interface AuthoredTest {
  isSample: boolean;
  /** SUBTASK scoring: the subtask this test belongs to; otherwise null. */
  subtask: number | null;
  input: string;
  output: string;
}

/**
 * Practice help, frozen with the version it belongs to. Tier 1 is a nudge,
 * tier 2 the key idea, tier 3 a near-solution; the editorial explains the
 * approach and its complexity with C++ and Python sketches. Release is gated
 * by helpAccess() in @recx/shared (never in contests or assessments).
 */
export interface HelpContent {
  hints: readonly [tier1: string, tier2: string, tier3: string];
  editorial: string;
}

export interface ReferenceEntry {
  language: LanguageKey;
  label: string;
  expected: Verdict;
  source: string;
}

export interface AuthoredProblem {
  slug: string;
  displayCode: string;
  title: string;
  difficulty: "EASY" | "MEDIUM" | "HARD";
  /** Topic tags, primary topic first (the starter sheet files a problem under its primary topic). */
  topics: readonly Topic[];
  statement: string;
  constraints: string[];
  timeLimitMs: number;
  memoryLimitKb: number;
  ioMode: "STDIN" | "FUNCTION";
  /** FUNCTION mode only: validated by functionSignatureSchema. */
  signature: FunctionSignature | null;
  compareMode: "TOKEN" | "CHECKER";
  scoringMode: "ICPC" | "SUBTASK";
  stopOnFirstFailure: boolean;
  /** CHECKER mode: testlib checker source (C++20), compiled by the judge. */
  checkerSource: string | null;
  subtasks: { index: number; points: number; dependsOn: number[] }[];
  /** Deterministic: every call returns byte-identical tests. */
  generateTests: () => AuthoredTest[];
  starters: Partial<Record<LanguageKey, string>>;
  references: ReferenceEntry[];
  help: HelpContent;
}

/** mulberry32 — a tiny deterministic PRNG, so every seed run writes identical tests. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A uniform integer in [lo, hi] from a prng stream. */
export function randomInt(r: () => number, lo: number, hi: number): number {
  return lo + Math.floor(r() * (hi - lo + 1));
}

/** Starter code for STDIN problems. */
export const STDIN_STARTERS: Partial<Record<LanguageKey, string>> = {
  cpp20: `#include <bits/stdc++.h>
using namespace std;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);
    // Read the input from standard input and print the answer.
    return 0;
}
`,
  py312: `import sys


def main():
    data = sys.stdin.buffer.read().split()
    # Solve the problem and print the answer.


main()
`,
};
