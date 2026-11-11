import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SNAPSHOT_JUMP_MIN_FINAL_TOKENS,
  SNAPSHOT_JUMP_SHARE,
  applyLinePatch,
  countTokens,
  diffLines,
  isSnapshotJump,
  parseLinePatch,
  reconstructTimeline,
  serialiseLinePatch,
} from "../src/exam-snapshot";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Round-trip: the patch between two texts must rebuild the second exactly. */
const roundTrips = (from: string, to: string) =>
  applyLinePatch(from, parseLinePatch(serialiseLinePatch(diffLines(from, to)))) === to;

describe("diffLines / applyLinePatch", () => {
  it("rebuilds an appended line", () => {
    expect(roundTrips("a\nb", "a\nb\nc")).toBe(true);
  });

  it("rebuilds a deletion, an insertion and a change", () => {
    expect(roundTrips("a\nb\nc", "a\nc")).toBe(true);
    expect(roundTrips("a\nc", "a\nb\nc")).toBe(true);
    expect(roundTrips("a\nb\nc", "a\nB\nc")).toBe(true);
  });

  it("rebuilds the empty cases", () => {
    expect(roundTrips("", "")).toBe(true);
    expect(roundTrips("", "a\nb")).toBe(true);
    expect(roundTrips("a\nb", "")).toBe(true);
  });

  it("preserves blank lines and trailing newlines exactly", () => {
    expect(roundTrips("a\n\n\nb", "a\n\nb")).toBe(true);
    expect(roundTrips("a\n", "a\n\n")).toBe(true);
    expect(roundTrips("a", "a\n")).toBe(true);
  });

  it("preserves leading whitespace, which is the whole content of a Python diff", () => {
    const from = "def f():\n    return 1\n";
    const to = "def f():\n        return 1\n";
    expect(roundTrips(from, to)).toBe(true);
    expect(applyLinePatch(from, diffLines(from, to))).toBe(to);
  });

  it("round-trips a realistic editing session, hash for hash", () => {
    const versions = [
      "",
      "int main() {\n}\n",
      "#include <stdio.h>\nint main() {\n}\n",
      "#include <stdio.h>\nint main() {\n  int n;\n  scanf(\"%d\", &n);\n}\n",
      "#include <stdio.h>\nint main() {\n  int n;\n  scanf(\"%d\", &n);\n  printf(\"%d\\n\", n * 2);\n  return 0;\n}\n",
      "#include <stdio.h>\n\nint main(void) {\n  int n;\n  if (scanf(\"%d\", &n) != 1) return 1;\n  printf(\"%d\\n\", n * 2);\n  return 0;\n}\n",
    ];
    for (let i = 1; i < versions.length; i++) {
      const rebuilt = applyLinePatch(versions[i - 1]!, diffLines(versions[i - 1]!, versions[i]!));
      expect(sha(rebuilt)).toBe(sha(versions[i]!));
    }
  });

  it("round-trips arbitrary line shuffles", () => {
    const pool = ["alpha", "beta", "", "  gamma", "delta();", "}", "{", "// note"];
    // Deterministic pseudo-random pairs: a seeded walk, so a failure is
    // reproducible rather than a once-seen flake.
    let seed = 12_345;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let round = 0; round < 200; round++) {
      const pick = (n: number) =>
        Array.from({ length: n }, () => pool[Math.floor(next() * pool.length)]!).join("\n");
      const from = pick(Math.floor(next() * 12));
      const to = pick(Math.floor(next() * 12));
      expect(roundTrips(from, to), `from=${JSON.stringify(from)} to=${JSON.stringify(to)}`).toBe(true);
    }
  });

  it("keeps the patch smaller than the text for a small edit", () => {
    const from = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const to = from.replace("line 100", "line one hundred");
    const patch = serialiseLinePatch(diffLines(from, to));
    expect(patch.length).toBeLessThan(from.length / 4);
  });

  it("merges runs rather than emitting one op per line", () => {
    const from = "a\nb\nc\nd\ne";
    const to = "a\nb\nc\nd\ne\nf\ng";
    const patch = diffLines(from, to);
    expect(patch).toEqual([
      ["=", 5],
      ["+", ["f", "g"]],
    ]);
  });

  it("refuses a patch that does not fit, rather than reconstructing the wrong thing", () => {
    expect(() => applyLinePatch("a", [["=", 5]])).toThrow(/does not fit/);
    expect(() => applyLinePatch("a\nb\nc", [["=", 1]])).toThrow(/left over/);
    expect(() => applyLinePatch("a", [["-", 9]])).toThrow(/does not fit/);
  });
});

describe("parseLinePatch", () => {
  it("accepts what serialiseLinePatch produces", () => {
    const patch = diffLines("a\nb", "a\nc");
    expect(parseLinePatch(serialiseLinePatch(patch))).toEqual(patch);
  });

  it("refuses anything that is not a patch", () => {
    for (const bad of ['"x"', "42", "null", "[[1,2]]", '[["?",1]]', '[["=","x"]]', '[["+",[1]]]', '[["=",-1]]', "[[]]"]) {
      expect(() => parseLinePatch(bad), bad).toThrow();
    }
  });
});

describe("reconstructTimeline", () => {
  const versions = ["int a;\n", "int a;\nint b;\n", "int a;\nint b;\nint c;\n"];

  const stored = [
    { content: versions[0]!, isDiff: false },
    { content: serialiseLinePatch(diffLines(versions[0]!, versions[1]!)), isDiff: true },
    { content: serialiseLinePatch(diffLines(versions[1]!, versions[2]!)), isDiff: true },
  ];

  it("rebuilds every version from one whole snapshot plus diffs", () => {
    expect(reconstructTimeline(stored)).toEqual(versions);
  });

  it("matches the stored hash of each version", () => {
    const rebuilt = reconstructTimeline(stored);
    for (const [i, text] of rebuilt.entries()) expect(sha(text)).toBe(sha(versions[i]!));
  });

  it("handles a single whole snapshot", () => {
    expect(reconstructTimeline([{ content: "x\n", isDiff: false }])).toEqual(["x\n"]);
  });

  it("handles an empty timeline", () => {
    expect(reconstructTimeline([])).toEqual([]);
  });

  it("refuses a timeline that starts with a diff", () => {
    expect(() => reconstructTimeline([{ content: '[["=",0]]', isDiff: true }])).toThrow(/starts with a diff/);
  });

  it("re-bases on a later whole snapshot", () => {
    // The writer may store a fresh whole snapshot at any point (after a
    // paste, say). The timeline must follow it rather than keep patching.
    const timeline = reconstructTimeline([
      { content: "a\n", isDiff: false },
      { content: "zzz\n", isDiff: false },
      { content: serialiseLinePatch(diffLines("zzz\n", "zzz\nyyy\n")), isDiff: true },
    ]);
    expect(timeline).toEqual(["a\n", "zzz\n", "zzz\nyyy\n"]);
  });
});

describe("countTokens", () => {
  it("counts identifiers, numbers and punctuation", () => {
    expect(countTokens("int n = 1;")).toBe(5); // int n = 1 ;
  });

  it("ignores whitespace and indentation", () => {
    expect(countTokens("a+b")).toBe(countTokens("a  +\n\t b"));
  });

  it("counts a string literal as one token, however long", () => {
    const short = countTokens('f("a");');
    const long = countTokens(`f("${"a".repeat(500)}");`);
    expect(long).toBe(short);
  });

  it("survives an unterminated string without looping", () => {
    expect(countTokens('f("unterminated')).toBeGreaterThan(0);
  });

  it("handles escapes inside a literal", () => {
    expect(countTokens('x = "a\\"b";')).toBe(countTokens('x = "ab";'));
  });

  it("is zero for nothing", () => {
    expect(countTokens("")).toBe(0);
    expect(countTokens("   \n\t ")).toBe(0);
  });
});

describe("isSnapshotJump", () => {
  const base = { finalTokens: 200, hadPasteOrProgrammaticInsert: false };

  it("fires when 60% of the solution appears in one interval with no paste recorded", () => {
    expect(isSnapshotJump({ ...base, addedTokens: 120 })).toBe(true);
  });

  it("does not fire just below the share", () => {
    expect(isSnapshotJump({ ...base, addedTokens: 119 })).toBe(false);
  });

  it("does not fire when the paste was recorded — then nothing was blind", () => {
    // An ordinary paste is already recorded as itself. Deriving a second
    // signal from the same act would double-count it against the candidate.
    expect(isSnapshotJump({ ...base, addedTokens: 200, hadPasteOrProgrammaticInsert: true })).toBe(false);
  });

  it("does not fire on a short solution, where 60% is two lines", () => {
    expect(isSnapshotJump({ addedTokens: 30, finalTokens: 30, hadPasteOrProgrammaticInsert: false })).toBe(false);
    expect(
      isSnapshotJump({
        addedTokens: SNAPSHOT_JUMP_MIN_FINAL_TOKENS,
        finalTokens: SNAPSHOT_JUMP_MIN_FINAL_TOKENS,
        hadPasteOrProgrammaticInsert: false,
      }),
    ).toBe(true);
  });

  it("exonerates steady work: four lines a minute never trips it", () => {
    // 20 intervals each adding 5% of the final solution.
    for (let i = 0; i < 20; i++) {
      expect(isSnapshotJump({ ...base, addedTokens: 10 })).toBe(false);
    }
  });

  it("does not fire for a candidate exempt from inserted-text signals", () => {
    expect(isSnapshotJump({ ...base, addedTokens: 200, exempt: true })).toBe(false);
  });

  it("does not fire on a deletion or a no-op interval", () => {
    expect(isSnapshotJump({ ...base, addedTokens: 0 })).toBe(false);
    expect(isSnapshotJump({ ...base, addedTokens: -50 })).toBe(false);
  });

  it("ignores non-finite inputs rather than deriving a signal from them", () => {
    expect(isSnapshotJump({ ...base, addedTokens: Number.NaN })).toBe(false);
    expect(isSnapshotJump({ addedTokens: 100, finalTokens: Number.NaN, hadPasteOrProgrammaticInsert: false })).toBe(false);
  });

  it("uses the share the spec fixes", () => {
    expect(SNAPSHOT_JUMP_SHARE).toBe(0.6);
  });
});
