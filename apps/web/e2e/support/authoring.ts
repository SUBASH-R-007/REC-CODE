import { createHash, randomBytes } from "node:crypto";

/**
 * The authoring journey's problem (the Phase 4 manual check): "Loud Echo", originally
 * authored for this suite — read one word, print it in upper case. Every
 * run gets its own runId, so its slug, title and canaries are unique and a
 * crashed earlier run never collides with this one.
 *
 * Canaries (must NEVER reach a student response):
 *   - hiddenInput    the input of a hidden test;
 *   - hiddenOutput   its expected output;
 *   - refCanary      a comment in every reference solution's source.
 * Positive control (MUST reach the student workspace): sampleInput.
 */

export interface TestCaseSpec {
  input: string;
  output: string;
  sample: boolean;
}

export interface ReferenceSpec {
  language: "cpp20" | "py312";
  label: string;
  expectedVerdict: "AC" | "WA";
  source: string;
}

export interface AuthoringFixture {
  runId: string;
  slug: string;
  title: string;
  statement: string;
  /** Added to the statement in revision 2. */
  r2Marker: string;
  tests: readonly TestCaseSpec[];
  sampleInput: string;
  hiddenInput: string;
  hiddenOutput: string;
  /** sha256 (hex) of the hidden test's input file, as the judge's blob route names it. */
  hiddenInputSha256: string;
  refCanary: string;
  /** The deliberately wrong "model": echoes the word unchanged, labelled expected AC. */
  wrongModel: ReferenceSpec;
  /** The fixed model (same label and language: edited in place). */
  fixedModelSource: string;
  references: readonly ReferenceSpec[];
  /** What the student submits (Python 3.12). */
  studentSource: string;
  retireReason: string;
}

/** Lower-case letters and digits only (slug-safe, and its upper case differs). */
export function newRunId(): string {
  return `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`.toLowerCase();
}

export function authoringFixture(runId: string = newRunId()): AuthoringFixture {
  const sampleInput = `e2esample${runId}`;
  const hiddenInput = `e2ehidden${runId}`;
  const refCanary = `e2e-ref-canary-${runId}`;
  const tests: TestCaseSpec[] = [
    { input: `${sampleInput}\n`, output: `${sampleInput.toUpperCase()}\n`, sample: true },
    { input: `${hiddenInput}\n`, output: `${hiddenInput.toUpperCase()}\n`, sample: false },
    { input: "MixedCase42\n", output: "MIXEDCASE42\n", sample: false },
    { input: "z\n", output: "Z\n", sample: false },
  ];
  const cpp = (body: string) =>
    [`// ${refCanary}`, "#include <cctype>", "#include <iostream>", "#include <string>", "", "int main() {", body, "}", ""].join("\n");
  const wrongModel: ReferenceSpec = {
    language: "cpp20",
    label: "Model",
    expectedVerdict: "AC",
    source: cpp(["  std::string word;", "  std::cin >> word;", '  std::cout << word << "\\n";', "  return 0;"].join("\n")),
  };
  const fixedModelSource = cpp(
    [
      "  std::string word;",
      "  std::cin >> word;",
      "  for (char& c : word) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));",
      '  std::cout << word << "\\n";',
      "  return 0;",
    ].join("\n"),
  );
  return {
    runId,
    slug: `e2e-loud-echo-${runId}`,
    title: `Loud Echo ${runId}`,
    statement: [
      "Read one word and print it in upper case.",
      "",
      "### Input",
      "",
      "One line with a single word of 1 to 100 English letters and digits.",
      "",
      "### Output",
      "",
      "The same word with every letter in upper case. Digits stay as they are.",
    ].join("\n"),
    r2Marker: `R2-marker-${runId}`,
    tests,
    sampleInput,
    hiddenInput,
    hiddenOutput: hiddenInput.toUpperCase(),
    hiddenInputSha256: createHash("sha256").update(`${hiddenInput}\n`, "utf8").digest("hex"),
    refCanary,
    wrongModel,
    fixedModelSource,
    references: [
      wrongModel,
      {
        language: "py312",
        label: "Python model",
        expectedVerdict: "AC",
        source: [`# ${refCanary}`, "print(input().strip().upper())", ""].join("\n"),
      },
      {
        language: "py312",
        label: "Echo unchanged",
        expectedVerdict: "WA",
        source: [`# ${refCanary}`, "print(input())", ""].join("\n"),
      },
    ],
    studentSource: "print(input().strip().upper())",
    retireReason: `E2E authoring journey ${runId} finished: retire the test problem.`,
  };
}
