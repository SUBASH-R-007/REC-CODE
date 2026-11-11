/**
 * lab-power-budget (REC-0005): FUNCTION mode, MEDIUM, Sliding Window. Originally
 * authored for REC Code: count the blocks of neighbouring lab computers whose
 * total power stays within the breaker's budget.
 */
import { parseType, serializeArgs, serializeValue, starterStub, type FunctionSignature } from "@recx/shared/harness";
import { prng, randomInt, type AuthoredProblem, type AuthoredTest } from "./types";

export const LAB_POWER_SIGNATURE: FunctionSignature = {
  className: "Solution",
  methodName: "countSafeBlocks",
  params: [
    { name: "watts", type: "list<int>" },
    { name: "budget", type: "long" },
  ],
  returns: "long",
  comparator: "EXACT",
  mutatedParam: null,
};

export const LAB_POWER_LIMITS = Object.freeze({
  maxN: 200_000,
  maxWatts: 10_000,
  maxBudget: 2_000_000_000,
});

/**
 * The reference count: a sliding window whose left edge only moves right.
 * Exact in doubles — the answer is at most n(n+1)/2 ≈ 2·10¹⁰ < 2⁵³.
 */
export function countSafeBlocks(watts: readonly number[], budget: number): number {
  let total = 0;
  let left = 0;
  let blocks = 0;
  for (let right = 0; right < watts.length; right++) {
    total += watts[right]!;
    while (total > budget) total -= watts[left++]!;
    blocks += right - left + 1;
  }
  return blocks;
}

function randomWatts(n: number, lo: number, hi: number, seed: number): number[] {
  const r = prng(seed);
  return Array.from({ length: n }, () => randomInt(r, lo, hi));
}

/** Mostly 1-watt machines with an occasional power-hungry one: the window must shed many at once. */
function spikyWatts(n: number, seed: number): number[] {
  const r = prng(seed);
  return Array.from({ length: n }, () => (r() < 0.002 ? LAB_POWER_LIMITS.maxWatts : 1));
}

const TYPES = LAB_POWER_SIGNATURE.params.map((p) => parseType(p.type));
const RETURNS = parseType(LAB_POWER_SIGNATURE.returns);

function labPowerTests(): AuthoredTest[] {
  const { maxN, maxWatts, maxBudget } = LAB_POWER_LIMITS;
  const cases: { watts: number[]; budget: number; isSample: boolean }[] = [
    { watts: [3, 1, 2, 4], budget: 5, isSample: true },
    { watts: [2, 2, 2], budget: 6, isSample: true },
    { watts: [10_000], budget: 1, isSample: false },
    { watts: [1], budget: 1, isSample: false },
    { watts: [5, 5, 5, 5], budget: 10, isSample: false },
    { watts: Array.from({ length: 10 }, () => 1), budget: 3, isSample: false },
    { watts: [1, 1, 1, 1, 9, 1, 1], budget: 9, isSample: false },
    { watts: randomWatts(1000, 1, 100, 51), budget: 1500, isSample: false },
    // Every block is safe: n(n+1)/2 ≈ 2·10¹⁰ needs 64 bits, and O(n²) is far too slow.
    { watts: randomWatts(maxN, 1, 10, 52), budget: maxBudget, isSample: false },
    { watts: randomWatts(maxN, 1, maxWatts, 53), budget: 1_000_000, isSample: false },
    { watts: randomWatts(maxN, 1, 3, 54), budget: 1, isSample: false },
    { watts: spikyWatts(maxN, 55), budget: 5000, isSample: false },
    { watts: Array.from({ length: maxN }, () => maxWatts), budget: maxWatts, isSample: false },
    // The whole row draws exactly the budget: still safe (≤), then one watt short.
    { watts: Array.from({ length: maxN }, () => maxWatts), budget: maxBudget, isSample: false },
    { watts: Array.from({ length: maxN }, () => maxWatts), budget: maxBudget - 1, isSample: false },
  ];
  return cases.map(({ watts, budget, isSample }) => ({
    isSample,
    subtask: null,
    input: serializeArgs(TYPES, [watts, budget]),
    output: serializeValue(RETURNS, countSafeBlocks(watts, budget)) + "\n",
  }));
}

export const LAB_POWER_BUDGET: AuthoredProblem = {
  slug: "lab-power-budget",
  displayCode: "REC-0005",
  title: "Lab Power Budget",
  difficulty: "MEDIUM",
  topics: ["SLIDING_WINDOW", "TWO_POINTERS"],
  statement: `The programming lab has \`n\` computers in a single row. Computer \`i\` draws \`watts[i]\` watts when it is switched on.

For a practical exam, the lab assistant switches on one **block** of computers that sit next to each other: computers \`l, l+1, …, r\` for some \`l ≤ r\`. A block is **safe** when its total power is at most \`budget\` watts; a bigger load trips the breaker.

Return how many different safe blocks there are. Two blocks are different when they start or end at a different computer.

### Example 1

\`\`\`
Input:  watts = [3, 1, 2, 4], budget = 5
Output: 6
\`\`\`

The safe blocks are \`[3]\`, \`[1]\`, \`[2]\`, \`[4]\`, \`[3, 1]\` and \`[1, 2]\`. The block \`[2, 4]\` draws 6 watts, which is too much.

### Example 2

\`\`\`
Input:  watts = [2, 2, 2], budget = 6
Output: 6
\`\`\`

Every block is safe — even all three computers together, which draw exactly 6 watts.

### Note

With 2·10⁵ computers the answer can be about 2·10¹⁰, which does not fit in a 32-bit \`int\`.`,
  constraints: ["1 ≤ watts.length ≤ 2·10⁵", "1 ≤ watts[i] ≤ 10⁴", "1 ≤ budget ≤ 2·10⁹"],
  timeLimitMs: 1000,
  memoryLimitKb: 262_144,
  ioMode: "FUNCTION",
  signature: LAB_POWER_SIGNATURE,
  compareMode: "TOKEN",
  scoringMode: "ICPC",
  stopOnFirstFailure: true,
  checkerSource: null,
  subtasks: [],
  generateTests: labPowerTests,
  starters: {
    cpp20: starterStub("cpp20", LAB_POWER_SIGNATURE),
    py312: starterStub("py312", LAB_POWER_SIGNATURE),
  },
  references: [
    {
      language: "cpp20",
      label: "Model solution (sliding window)",
      expected: "AC",
      source: `class Solution {
public:
    long long countSafeBlocks(vector<int>& watts, long long budget) {
        long long total = 0, blocks = 0;
        int left = 0;
        for (int right = 0; right < (int)watts.size(); ++right) {
            total += watts[right];
            while (total > budget) total -= watts[left++];
            blocks += right - left + 1;
        }
        return blocks;
    }
};
`,
    },
    {
      language: "py312",
      label: "Model solution (sliding window)",
      expected: "AC",
      source: `class Solution:
    def countSafeBlocks(self, watts: List[int], budget: int) -> int:
        total = 0
        left = 0
        blocks = 0
        for right, w in enumerate(watts):
            total += w
            while total > budget:
                total -= watts[left]
                left += 1
            blocks += right - left + 1
        return blocks
`,
    },
    {
      language: "java21",
      label: "Model solution (sliding window)",
      expected: "AC",
      source: `class Solution {
    public long countSafeBlocks(int[] watts, long budget) {
        long total = 0;
        long blocks = 0;
        int left = 0;
        for (int right = 0; right < watts.length; right++) {
            total += watts[right];
            while (total > budget) total -= watts[left++];
            blocks += right - left + 1;
        }
        return blocks;
    }
}
`,
    },
    {
      language: "cpp20",
      label: "Deliberately wrong: shrinks the window by one at most",
      expected: "WA",
      source: `// Uses 'if' where a 'while' is needed: after a power-hungry computer joins,
// dropping one computer from the left is not always enough.
class Solution {
public:
    long long countSafeBlocks(vector<int>& watts, long long budget) {
        long long total = 0, blocks = 0;
        int left = 0;
        for (int right = 0; right < (int)watts.size(); ++right) {
            total += watts[right];
            if (total > budget) total -= watts[left++];
            blocks += right - left + 1;
        }
        return blocks;
    }
};
`,
    },
    {
      language: "cpp20",
      label: "Deliberately slow: every start, O(n²)",
      expected: "TLE",
      source: `// Correct, but tries every starting computer and extends the block while
// it stays safe: about n²/2 steps when most blocks are safe.
class Solution {
public:
    long long countSafeBlocks(vector<int>& watts, long long budget) {
        int n = watts.size();
        long long blocks = 0;
        for (int l = 0; l < n; ++l) {
            long long total = 0;
            for (int r = l; r < n; ++r) {
                total += watts[r];
                if (total > budget) break;
                ++blocks;
            }
        }
        return blocks;
    }
};
`,
    },
  ],
  help: {
    hints: [
      `Fix the **right end** \`r\` of a block and ask: which left ends \`l\` make \`l … r\` safe? Every computer draws at least 1 watt, so moving \`l\` further left can only make the total bigger.`,
      `Because all watts are positive, the safe left ends for a fixed \`r\` form one range \`[L(r), r]\`, and \`L(r)\` never moves left as \`r\` moves right. So keep a **window** \`[left, right]\` and its total: add \`watts[right]\`, then drop computers from the left until the total fits the budget. Every block that ends at \`right\` and starts at \`left\` or later is safe — that is \`right - left + 1\` blocks.`,
      `For \`right\` from 0 to n−1: \`total += watts[right]\`; **while** \`total > budget\`: \`total -= watts[left]\`, \`left += 1\`; then \`answer += right - left + 1\`. Each computer enters and leaves the window at most once, so this is O(n). It must be a \`while\`, not an \`if\`: one power-hungry computer can push several cheap ones out at once. Keep \`total\` and \`answer\` in 64-bit integers.`,
    ],
    editorial: `### Approach

**Brute force.** Try every left end \`l\`, extend the block to the right while it stays safe, and count. That is correct, but when most blocks are safe it takes about n²/2 ≈ 2·10¹⁰ steps — far too slow.

**Key observation.** Every computer draws a *positive* number of watts. So for a fixed right end \`r\`, making the block longer (moving \`l\` left) only increases the total. The safe left ends therefore form one range \`[L(r), r]\` — and when \`r\` moves one step right, the total of every block grows, so \`L(r)\` can only stay where it is or move right.

That is exactly a **sliding window**:

1. Move \`right\` from the first computer to the last, adding \`watts[right]\` to \`total\`.
2. While \`total > budget\`, remove \`watts[left]\` and move \`left\` one step right. (A single computer drawing more than the budget empties the window completely, and that is fine: it then contributes 0 blocks.)
3. Now every block ending at \`right\` and starting anywhere in \`[left, right]\` is safe: add \`right - left + 1\`.

Two details matter:

- It must be a \`while\`, not an \`if\`. After a power-hungry computer joins, dropping one cheap computer from the left may not be enough.
- With n = 2·10⁵ the answer can reach n(n+1)/2 ≈ 2·10¹⁰. Use \`long long\` for the answer (and for \`total\`).

### Complexity

- Time: O(n) — \`left\` and \`right\` each move at most n times.
- Memory: O(1) besides the input.

(Another correct route: prefix sums, then for each right end binary-search the first safe left end — O(n log n).)

### C++

\`\`\`cpp
class Solution {
public:
    long long countSafeBlocks(vector<int>& watts, long long budget) {
        long long total = 0, blocks = 0;
        int left = 0;
        for (int right = 0; right < (int)watts.size(); ++right) {
            total += watts[right];
            while (total > budget) total -= watts[left++];
            blocks += right - left + 1;
        }
        return blocks;
    }
};
\`\`\`

### Python

\`\`\`python
class Solution:
    def countSafeBlocks(self, watts: List[int], budget: int) -> int:
        total = left = blocks = 0
        for right, w in enumerate(watts):
            total += w
            while total > budget:
                total -= watts[left]
                left += 1
            blocks += right - left + 1
        return blocks
\`\`\`
`,
  },
};
