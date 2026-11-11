import { describe, expect, it } from "vitest";
import {
  PROBLEM_KINDS,
  PROBLEM_KIND_HINT,
  PROBLEM_KIND_LABEL,
  isNamedProblemKind,
  problemKind,
  type ProblemKindFacts,
} from "../src/index";

/**
 * The kind of a question, derived from the three fields the version's own
 * CHECKs tie it to (Phase 12p, slice 3).
 *
 * The point of this module is that one word appears in two places — the
 * list a student picks from and the bar over the editor — and they cannot
 * be allowed to drift. So what is asserted here is the derivation and the
 * vocabulary, not the markup.
 */
const ordinary: ProblemKindFacts = { ioMode: "STDIN", compareMode: "TOKEN", maxEditedLines: null };

describe("problemKind", () => {
  it("calls an ordinary program an ordinary program", () => {
    expect(problemKind(ordinary)).toBe("program");
    expect(problemKind({ ...ordinary, ioMode: "FUNCTION" })).toBe("program");
    expect(problemKind({ ...ordinary, compareMode: "CHECKER" })).toBe("program");
    expect(problemKind({ ...ordinary, compareMode: "FLOAT" })).toBe("program");
  });

  it("reads a SQL version from either half of its mirror", () => {
    // ProblemVersion_sql_mode_mirror makes these two the same fact; a row
    // that somehow had only one of them is still a query, not a program.
    expect(problemKind({ ioMode: "SQL", compareMode: "ROWS", maxEditedLines: null })).toBe("sql");
    expect(problemKind({ ...ordinary, ioMode: "SQL" })).toBe("sql");
    expect(problemKind({ ...ordinary, compareMode: "ROWS" })).toBe("sql");
  });

  it("reads a conversation from the compare mode", () => {
    expect(problemKind({ ...ordinary, compareMode: "INTERACTIVE" })).toBe("interactive");
  });

  it("reads an answer-only question from the io mode", () => {
    expect(problemKind({ ...ordinary, ioMode: "OUTPUT_ONLY" })).toBe("answer");
  });

  it("reads a debugging question from its budget, which is what makes it one", () => {
    expect(problemKind({ ...ordinary, maxEditedLines: 1 })).toBe("debugging");
    expect(problemKind({ ...ordinary, maxEditedLines: 50 })).toBe("debugging");
    // A budget of zero is refused by ProblemVersion_debug_budget_range, but
    // the derivation must not quietly treat it as "no budget" either.
    expect(problemKind({ ...ordinary, maxEditedLines: 0 })).toBe("debugging");
  });

  it("never returns a kind that is not in the list", () => {
    const facts: ProblemKindFacts[] = [
      ordinary,
      { ioMode: "SQL", compareMode: "ROWS", maxEditedLines: null },
      { ...ordinary, compareMode: "INTERACTIVE" },
      { ...ordinary, ioMode: "OUTPUT_ONLY" },
      { ...ordinary, maxEditedLines: 3 },
    ];
    for (const f of facts) expect(PROBLEM_KINDS).toContain(problemKind(f));
  });
});

describe("the words a student reads", () => {
  it("names every kind but an ordinary program", () => {
    for (const kind of PROBLEM_KINDS) {
      if (kind === "program") {
        expect(PROBLEM_KIND_LABEL[kind]).toBe("");
        expect(PROBLEM_KIND_HINT[kind]).toBe("");
        expect(isNamedProblemKind(kind)).toBe(false);
        continue;
      }
      expect(isNamedProblemKind(kind)).toBe(true);
      // A chip, so short; a sentence behind it, so it means something.
      expect(PROBLEM_KIND_LABEL[kind].length, kind).toBeGreaterThan(1);
      expect(PROBLEM_KIND_LABEL[kind].length, `${kind} is a chip, not a sentence`).toBeLessThanOrEqual(14);
      expect(PROBLEM_KIND_HINT[kind], kind).toMatch(/\.$/);
      expect(PROBLEM_KIND_HINT[kind].length, kind).toBeGreaterThan(20);
    }
  });

  it("gives each kind its own word, so a chip identifies it", () => {
    const named = PROBLEM_KINDS.filter(isNamedProblemKind).map((k) => PROBLEM_KIND_LABEL[k]);
    expect(new Set(named).size).toBe(named.length);
  });

  it("says SQL and PostgreSQL rather than inventing a third name for the dialect", () => {
    expect(PROBLEM_KIND_LABEL.sql).toBe("SQL");
    expect(PROBLEM_KIND_HINT.sql).toContain("PostgreSQL");
  });
});
