import { describe, expect, it } from "vitest";
import { functionSignatureSchema } from "../src/harness/signature";
import { generateTwoSumTests, TWO_SUM } from "../src/samples/two-sum";
import { isTopic } from "../src/topics";

const tests = generateTwoSumTests();

function decode(input: string): { nums: number[]; target: number } {
  const lines = input.split("\n");
  expect(lines).toHaveLength(3); // two parameters + the trailing newline
  expect(lines[2]).toBe("");
  return { nums: JSON.parse(lines[0]!) as number[], target: JSON.parse(lines[1]!) as number };
}

function answer(output: string): [number, number] {
  const m = /^\[(\d+),(\d+)\]\n$/.exec(output);
  expect(m, `expected output "[i,j]\\n", got ${JSON.stringify(output.slice(0, 40))}`).not.toBeNull();
  return [Number(m![1]), Number(m![2])];
}

describe("generateTwoSumTests", () => {
  it("returns 14 tests indexed 0..13", () => {
    expect(tests).toHaveLength(14);
    expect(tests.map((t) => t.index)).toEqual([...Array(14).keys()]);
  });

  it("puts exactly two samples first", () => {
    expect(tests.map((t) => t.isSample)).toEqual([true, true, ...Array<boolean>(12).fill(false)]);
  });

  it("is deterministic across calls", () => {
    expect(generateTwoSumTests()).toEqual(tests);
  });

  it("matches the statement's examples for the samples", () => {
    expect(tests[0]).toMatchObject({ input: "[2,7,11,15]\n9\n", output: "[0,1]\n" });
    expect(tests[1]).toMatchObject({ input: "[3,2,4]\n6\n", output: "[1,2]\n" });
  });

  it.each(tests.map((t) => [t.index, t] as const))("test %i: expected output is [i,j] with i<j summing to target", (_i, t) => {
    const { nums, target } = decode(t.input);
    const [i, j] = answer(t.output);
    expect(i).toBeLessThan(j);
    expect(j).toBeLessThan(nums.length);
    expect(nums[i]! + nums[j]!).toBe(target);
  });

  it.each(tests.map((t) => [t.index, t] as const))("test %i: the pair is unique and within the constraints", (_i, t) => {
    const { nums, target } = decode(t.input);
    expect(nums.length).toBeGreaterThanOrEqual(2);
    expect(nums.length).toBeLessThanOrEqual(100_000);
    expect(Math.abs(target)).toBeLessThanOrEqual(2_000_000_000);
    expect(nums.filter((x) => !Number.isInteger(x) || Math.abs(x) > 1_000_000_000)).toEqual([]);
    // Count index pairs (i<j) summing to target in O(n).
    const seen = new Map<number, number>();
    let pairs = 0;
    for (const x of nums) {
      pairs += seen.get(target - x) ?? 0;
      seen.set(x, (seen.get(x) ?? 0) + 1);
    }
    expect(pairs).toBe(1);
  });

  it("covers the large inputs up to 10^5 elements", () => {
    const sizes = tests.map((t) => decode(t.input).nums.length);
    expect(Math.max(...sizes)).toBe(100_000);
  });
});

describe("TWO_SUM metadata", () => {
  it("has a valid FUNCTION signature and known topics", () => {
    expect(functionSignatureSchema.safeParse(TWO_SUM.signature).success).toBe(true);
    expect(TWO_SUM.topics.every(isTopic)).toBe(true);
    expect(TWO_SUM.difficulty).toBe("EASY");
  });
});
