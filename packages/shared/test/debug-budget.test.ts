import { describe, expect, it } from "vitest";
import {
  DEBUG_BUDGET,
  DEBUG_NOTICES,
  countEditedLines,
  debugChipLabel,
  debugCountLabel,
  debugOverBudget,
  debugRuleSentence,
  isDebugBudget,
  significantLines,
} from "../src/debug-problem";

/**
 * The edit budget of a debugging problem (Phase 12m, slice 1).
 *
 * One number decides whether a submission is judged at all, and the
 * student reads the same number in the editor as the server refuses on, so
 * this is the test that keeps the two honest.
 */

const BROKEN = `#include <iostream>
int main() {
  int n;
  std::cin >> n;
  int sum = 0;
  for (int i = 0; i <= n; i++) sum += i;
  std::cout << sum << std::endl;
}
`;

describe("significantLines", () => {
  it("drops blank lines and indentation", () => {
    expect(significantLines("  a\n\n\t b \n\n")).toEqual(["a", "b"]);
  });

  it("reads both line endings", () => {
    expect(significantLines("a\r\nb\r\n")).toEqual(["a", "b"]);
  });
});

describe("countEditedLines", () => {
  it("is 0 for the program as it was given", () => {
    expect(countEditedLines(BROKEN, BROKEN)).toBe(0);
  });

  it("is 0 when only the indentation and the blank lines changed", () => {
    const reformatted = BROKEN.replace(/^ {2}/gm, "    ").replace(/\n/g, "\n\n");
    expect(countEditedLines(BROKEN, reformatted)).toBe(0);
  });

  it("is 1 for the one-line fix the question is about", () => {
    const fixed = BROKEN.replace("i <= n", "i < n");
    expect(countEditedLines(BROKEN, fixed)).toBe(1);
  });

  it("counts a deleted line, and three of them", () => {
    const lines = BROKEN.trimEnd().split("\n");
    expect(countEditedLines(BROKEN, [...lines.slice(0, 4), ...lines.slice(5)].join("\n"))).toBe(1);
    expect(countEditedLines(BROKEN, [...lines.slice(0, 2), ...lines.slice(5)].join("\n"))).toBe(3);
  });

  it("counts an added line", () => {
    expect(countEditedLines(BROKEN, BROKEN.replace("int sum = 0;", "int sum = 0;\n  int unused = 1;"))).toBe(1);
  });

  it("counts replacing one line with two as two", () => {
    expect(countEditedLines(BROKEN, BROKEN.replace("int sum = 0;", "long long sum = 0;\n  long long i = 0;"))).toBe(2);
  });

  it("counts a moved line once, not twice", () => {
    expect(countEditedLines("a\nb\nc\n", "b\na\nc\n")).toBe(1);
  });

  it("counts a rewrite as the whole program", () => {
    expect(countEditedLines("a\nb\nc\n", "x\ny\nz\n")).toBe(3);
  });

  it("counts an emptied editor as the whole program, and a program typed into an empty one", () => {
    expect(countEditedLines(BROKEN, "")).toBe(8);
    expect(countEditedLines("", "a\nb\n")).toBe(2);
  });

  it("is symmetric in the only sense that matters: the distance, not the direction", () => {
    const fixed = BROKEN.replace("i <= n", "i < n");
    expect(countEditedLines(fixed, BROKEN)).toBe(countEditedLines(BROKEN, fixed));
  });

  it("does not charge for a repeated line that is still there", () => {
    expect(countEditedLines("x\nx\nx\n", "x\nx\nx\n")).toBe(0);
    expect(countEditedLines("x\nx\nx\n", "x\nx\n")).toBe(1);
  });

  it("answers for a program far larger than any exact diff would be taken over", () => {
    // 3,000 lines against 3,000 is nine million cells: the multiset count
    // takes over, and must still refuse a rewrite and pass an untouched file.
    const big = Array.from({ length: 3_000 }, (_, i) => `line ${i};`).join("\n");
    expect(countEditedLines(big, big)).toBe(0);
    expect(countEditedLines(big, big.replace("line 7;", "line 7 fixed;"))).toBe(1);
    const other = Array.from({ length: 3_000 }, (_, i) => `other ${i};`).join("\n");
    expect(countEditedLines(big, other)).toBe(3_000);
  });
});

describe("isDebugBudget", () => {
  it("takes a whole number in range and nothing else", () => {
    expect(isDebugBudget(1)).toBe(true);
    expect(isDebugBudget(DEBUG_BUDGET.max)).toBe(true);
    expect(isDebugBudget(0)).toBe(false);
    expect(isDebugBudget(DEBUG_BUDGET.max + 1)).toBe(false);
    expect(isDebugBudget(2.5)).toBe(false);
    expect(isDebugBudget(null)).toBe(false);
    expect(isDebugBudget("3")).toBe(false);
  });
});

describe("the words a student reads", () => {
  it("says the rule with the number in it", () => {
    expect(debugRuleSentence(2)).toContain("at most 2 lines");
    expect(debugRuleSentence(1)).toContain("at most 1 line.");
  });

  it("names the budget in the chip and the count beside it", () => {
    expect(debugChipLabel(3)).toContain("at most 3 lines");
    expect(debugCountLabel(0, 3)).toBe("0 of 3 lines changed");
    expect(debugCountLabel(1, 1)).toBe("1 of 1 line changed");
  });

  it("gives both numbers on a refusal, and says what to do", () => {
    const message = debugOverBudget(7, 2);
    expect(message).toContain("7 lines");
    expect(message).toContain("allows 2");
    expect(message).toContain("Reset");
  });

  it("explains what does not count, so the counter is actionable", () => {
    expect(DEBUG_NOTICES.counted).toContain("Blank lines are ignored");
    expect(DEBUG_NOTICES.counted).toContain("indentation");
  });
});
