import type { FunctionSignature } from "../harness/signature";
import { parseType } from "../harness/signature";
import { serializeArgs, serializeValue } from "../harness/values";
import type { LanguageKey } from "../languages";

/**
 * The Phase 1 seed problem. Originally authored for REC Code (statement,
 * constraints and tests are our own). Shared by the web seed and the judge
 * integration test so both judge exactly the same data.
 */
export const TWO_SUM = {
  slug: "two-sum",
  displayCode: "REC-0001",
  title: "Two Sum",
  difficulty: "EASY" as const,
  topics: ["ARRAYS_HASHING"] as const,
  timeLimitMs: 1000,
  memoryLimitKb: 262_144,
  statement: `You are given an array of integers \`nums\` and an integer \`target\`.

Find the **two different positions** \`i\` and \`j\` such that \`nums[i] + nums[j] == target\`, and return them as \`[i, j]\` with \`i < j\`.

Every test is built so that exactly one such pair exists. You may not use the same position twice, although two different positions may hold equal values.

### Example 1

\`\`\`
Input:  nums = [2, 7, 11, 15], target = 9
Output: [0, 1]
\`\`\`

\`nums[0] + nums[1] = 2 + 7 = 9\`, so the answer is \`[0, 1]\`.

### Example 2

\`\`\`
Input:  nums = [3, 2, 4], target = 6
Output: [1, 2]
\`\`\`

### Follow-up

A pair of nested loops is O(n²). Can you find the pair in a single pass?`,
  constraints: [
    "2 ≤ nums.length ≤ 10⁵",
    "-10⁹ ≤ nums[i] ≤ 10⁹",
    "-2·10⁹ ≤ target ≤ 2·10⁹",
    "Exactly one valid pair exists.",
    "Return the indices in increasing order.",
  ],
  signature: {
    className: "Solution",
    methodName: "twoSum",
    params: [
      { name: "nums", type: "list<int>" },
      { name: "target", type: "long" },
    ],
    returns: "list<int>",
    comparator: "EXACT",
    mutatedParam: null,
  } satisfies FunctionSignature,
} as const;

export const TWO_SUM_STARTER: Partial<Record<LanguageKey, string>> = {
  cpp20: `class Solution {
public:
    vector<int> twoSum(vector<int>& nums, long long target) {

    }
};
`,
  py312: `class Solution:
    def twoSum(self, nums: List[int], target: int) -> List[int]:

`,
};

/** Model solutions — never exposed to students by any query path. */
export const TWO_SUM_REFERENCE: Partial<Record<LanguageKey, { source: string; expected: "AC" | "TLE" | "WA" }[]>> = {
  cpp20: [
    {
      expected: "AC",
      source: `class Solution {
public:
    vector<int> twoSum(vector<int>& nums, long long target) {
        unordered_map<long long, int> seen;
        seen.reserve(nums.size() * 2);
        for (int i = 0; i < (int)nums.size(); ++i) {
            auto it = seen.find(target - nums[i]);
            if (it != seen.end()) return {it->second, i};
            seen.emplace(nums[i], i);
        }
        return {};
    }
};
`,
    },
    {
      // Deliberately wrong: returns the pair in the wrong order.
      expected: "WA",
      source: `class Solution {
public:
    vector<int> twoSum(vector<int>& nums, long long target) {
        unordered_map<long long, int> seen;
        for (int i = 0; i < (int)nums.size(); ++i) {
            auto it = seen.find(target - nums[i]);
            if (it != seen.end()) return {i, it->second};
            seen.emplace(nums[i], i);
        }
        return {};
    }
};
`,
    },
  ],
  py312: [
    {
      expected: "AC",
      source: `class Solution:
    def twoSum(self, nums: List[int], target: int) -> List[int]:
        seen = {}
        for i, x in enumerate(nums):
            j = seen.get(target - x)
            if j is not None:
                return [j, i]
            seen.setdefault(x, i)
        return []
`,
    },
  ],
  // java21 is not enabled by default; the golden suite judges this whenever
  // RECX_GOLDEN_EXTRA_LANGUAGES includes java21 (scripts/dev/linux-gate.sh).
  java21: [
    {
      expected: "AC",
      source: `class Solution {
    public int[] twoSum(int[] nums, long target) {
        HashMap<Long, Integer> seen = new HashMap<>(nums.length * 2);
        for (int i = 0; i < nums.length; i++) {
            Integer j = seen.get(target - nums[i]);
            if (j != null) return new int[] {j, i};
            seen.putIfAbsent((long) nums[i], i);
        }
        return new int[0];
    }
}
`,
    },
  ],
};

export interface GeneratedTest {
  index: number;
  isSample: boolean;
  input: string;
  output: string;
}

/** mulberry32 — tiny deterministic PRNG so the tests are reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Exactly one pair (i<j) must sum to target; returns it or throws. */
function uniquePair(nums: number[], target: number): [number, number] {
  const firstIndex = new Map<number, number>();
  const counts = new Map<number, number>();
  for (const x of nums) counts.set(x, (counts.get(x) ?? 0) + 1);
  let pairs = 0;
  let answer: [number, number] | null = null;
  for (let j = 0; j < nums.length; j++) {
    const need = target - nums[j]!;
    const i = firstIndex.get(need);
    if (i !== undefined) {
      pairs++;
      answer = [i, j];
    }
    if (!firstIndex.has(nums[j]!)) firstIndex.set(nums[j]!, j);
  }
  // Count unordered value pairs to make sure the answer is unique.
  let total = 0;
  for (const [v, c] of counts) {
    const w = target - v;
    if (w === v) total += (c * (c - 1)) / 2;
    else if (w > v && counts.has(w)) total += c * counts.get(w)!;
  }
  if (!answer || pairs < 1 || total !== 1) throw new Error("two-sum generator produced a non-unique instance");
  return answer;
}

function build(nums: number[], target: number) {
  const sig = TWO_SUM.signature;
  const types = sig.params.map((p) => parseType(p.type));
  return {
    input: serializeArgs(types, [nums, target]),
    output: serializeValue(parseType(sig.returns), uniquePair(nums, target)) + "\n",
  };
}

/** Distinct random values in [lo, hi], none of which pair to `target` except the planted pair. */
function plant(n: number, lo: number, hi: number, seed: number): { nums: number[]; target: number } {
  const r = rng(seed);
  const pick = () => lo + Math.floor(r() * (hi - lo + 1));
  for (;;) {
    const a = pick();
    const b = pick();
    const target = a + b;
    const used = new Set<number>([a, b]);
    const nums: number[] = [];
    while (nums.length < n - 2) {
      const x = pick();
      if (used.has(x) || used.has(target - x)) continue;
      used.add(x);
      nums.push(x);
    }
    const i = Math.floor(r() * (n - 1));
    const j = i + 1 + Math.floor(r() * (n - 1 - i));
    nums.splice(i, 0, a);
    nums.splice(j, 0, b);
    try {
      uniquePair(nums, target);
      return { nums, target };
    } catch {
      // Extremely unlikely collision — draw again from the same stream.
    }
  }
}

/** 2 samples + 12 hidden tests, deterministic. */
export function generateTwoSumTests(): GeneratedTest[] {
  const cases: { nums: number[]; target: number; isSample: boolean }[] = [
    { nums: [2, 7, 11, 15], target: 9, isSample: true },
    { nums: [3, 2, 4], target: 6, isSample: true },
    { nums: [3, 3], target: 6, isSample: false },
    { nums: [-1, -2, -3, -4, -5], target: -8, isSample: false },
    { nums: [0, 4, 3, 0], target: 0, isSample: false },
    { nums: [1000000000, -1000000000], target: 0, isSample: false },
    { nums: [1000000000, 999999999, 5], target: 1999999999, isSample: false },
    { nums: [-1000000000, 7, -999999999], target: -1999999999, isSample: false },
    { nums: [5, 75, 25], target: 100, isSample: false },
    { nums: [1, 5, 1, 9], target: 2, isSample: false },
  ];
  const big = [
    plant(1_000, -1_000, 1_000_000, 11),
    plant(10_000, -1_000_000_000, 1_000_000_000, 23),
    plant(50_000, -1_000_000_000, 1_000_000_000, 37),
    plant(100_000, -1_000_000_000, 1_000_000_000, 41),
  ];
  for (const b of big) cases.push({ ...b, isSample: false });

  return cases.map((c, index) => ({ index, isSample: c.isSample, ...build(c.nums, c.target) }));
}
