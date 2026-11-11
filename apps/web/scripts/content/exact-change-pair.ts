/**
 * exact-change-pair (REC-0011): FUNCTION mode, EASY, CUSTOM_CHECKER.
 * Originally authored for REC Code: spend a canteen voucher exactly on two
 * different items. Any valid pair of positions is accepted, judged by a
 * testlib checker.
 */
import { parseType, serializeArgs, serializeValue, starterStub, type FunctionSignature } from "@recx/shared/harness";
import { functionChecker } from "./checker-json";
import { prng, randomInt, type AuthoredProblem, type AuthoredTest } from "./types";

export const EXACT_CHANGE_SIGNATURE: FunctionSignature = {
  className: "Solution",
  methodName: "findPair",
  params: [
    { name: "prices", type: "list<int>" },
    { name: "amount", type: "long" },
  ],
  returns: "pair<int,int>",
  comparator: "CUSTOM_CHECKER",
  mutatedParam: null,
};

export const EXACT_CHANGE_LIMITS = Object.freeze({
  maxN: 200_000,
  maxPrice: 1_000_000_000,
  maxAmount: 2_000_000_000,
});

/** The jury's pair: scan left to right and look the partner up before remembering the price. */
export function changePair(prices: readonly number[], amount: number): [number, number] {
  const firstAt = new Map<number, number>();
  for (const [j, price] of prices.entries()) {
    const i = firstAt.get(amount - price);
    if (i !== undefined) return [i, j];
    if (!firstAt.has(price)) firstAt.set(price, j);
  }
  throw new Error("exact-change-pair: no pair adds up to the amount");
}

/** The checker's rule: two different positions i < j whose prices add up to the amount. */
export function isValidChangePair(prices: readonly number[], amount: number, pair: readonly number[]): boolean {
  if (pair.length !== 2) return false;
  const [i, j] = pair as [number, number];
  return Number.isInteger(i) && Number.isInteger(j) && 0 <= i && i < j && j < prices.length && prices[i]! + prices[j]! === amount;
}

function randomPrices(n: number, lo: number, hi: number, r: () => number): number[] {
  return Array.from({ length: n }, () => randomInt(r, lo, hi));
}

/**
 * n prices where only the last two add up to the amount: every other price is
 * at most `smallMax`, too small to reach the amount with anything but `last1`
 * and `last2`. A brute force that tries every pair checks about n²/2 of them.
 */
function latePairOnly(n: number, smallMax: number, last1: number, last2: number, seed: number): number[] {
  const prices = randomPrices(n - 2, 1, smallMax, prng(seed));
  prices.push(last1, last2);
  return prices;
}

const TYPES = EXACT_CHANGE_SIGNATURE.params.map((p) => parseType(p.type));
const RETURNS = parseType(EXACT_CHANGE_SIGNATURE.returns);

function exactChangeTests(): AuthoredTest[] {
  const { maxN, maxPrice, maxAmount } = EXACT_CHANGE_LIMITS;
  const randomWithPair = (n: number, hi: number, seed: number) => {
    const r = prng(seed);
    const prices = randomPrices(n, 1, hi, r);
    const a = randomInt(r, 0, n - 2);
    const b = randomInt(r, a + 1, n - 1);
    return { prices, amount: prices[a]! + prices[b]! };
  };
  const cases: { prices: number[]; amount: number; isSample: boolean }[] = [
    { prices: [40, 25, 60, 15, 35], amount: 75, isSample: true },
    { prices: [50, 50, 20], amount: 100, isSample: true },
    { prices: [1, 1], amount: 2, isSample: false },
    // 30 is half of 60, but there is only one 30: it cannot pair with itself.
    { prices: [30, 45, 15], amount: 60, isSample: false },
    // The sum does not fit in a 32-bit int.
    { prices: [maxPrice, maxPrice], amount: maxAmount, isSample: false },
    { prices: [1, maxPrice - 1], amount: maxPrice, isSample: false },
    { prices: [7, 3, 5, 5, 9, 1], amount: 10, isSample: false },
    { ...randomWithPair(1000, 1_000_000, 121), isSample: false },
    { prices: latePairOnly(maxN, 400_000_000, maxPrice, 700_000_000, 122), amount: 1_700_000_000, isSample: false },
    { prices: Array.from({ length: maxN }, () => 500_000_000), amount: maxPrice, isSample: false },
    {
      // Half the amount sits at the very front, once; the only real pair is at the end.
      prices: [600_000_000, ...latePairOnly(maxN - 1, 290_000_000, 900_000_000, 300_000_000, 123)],
      amount: 1_200_000_000,
      isSample: false,
    },
    { ...randomWithPair(maxN, maxPrice, 124), isSample: false },
    { prices: latePairOnly(maxN, maxPrice - 1, maxPrice, maxPrice, 125), amount: maxAmount, isSample: false },
    {
      // The two ends of the counter: the first and the last item.
      prices: [600_000_000, ...randomPrices(maxN - 2, 1, 590_000_000, prng(126)), 900_000_000],
      amount: 1_500_000_000,
      isSample: false,
    },
  ];
  return cases.map(({ prices, amount, isSample }) => ({
    isSample,
    subtask: null,
    input: serializeArgs(TYPES, [prices, amount]),
    output: serializeValue(RETURNS, changePair(prices, amount)) + "\n",
  }));
}

const EXACT_CHANGE_CHECKER = functionChecker(
  String.raw`// exact-change-pair: accept ANY two positions i < j with
// prices[i] + prices[j] == amount.
//   input.txt   line 1: prices, line 2: amount
//   answer.txt  the jury's pair (checked as well: a bad one is FAIL, not WA)
//   output.txt  the contestant's pair`,
  String.raw`void checkPair(const std::vector<long long>& pair, const std::vector<long long>& prices, long long amount,
               TResult verdict, const char* who) {
    if (pair.size() != 2) quitf(verdict, "%s has %d values, expected 2", who, (int)pair.size());
    long long i = pair[0], j = pair[1];
    long long n = (long long)prices.size();
    if (i < 0 || i >= n || j < 0 || j >= n) {
        quitf(verdict, "%s [%lld, %lld] names a position outside 0..%lld", who, i, j, n - 1);
    }
    if (i >= j) quitf(verdict, "%s [%lld, %lld] must have the smaller position first and two different positions", who, i, j);
    if (prices[i] + prices[j] != amount) {
        quitf(verdict, "%s [%lld, %lld]: %lld + %lld = %lld, not %lld", who, i, j, prices[i], prices[j],
              prices[i] + prices[j], amount);
    }
}

int main(int argc, char* argv[]) {
    registerTestlibCmd(argc, argv);

    JsonLine pricesLine(inf.readLine(), _fail, "input prices");
    std::vector<long long> prices = pricesLine.list(1, 1000000000);
    pricesLine.end();
    if (prices.size() < 2) quitf(_fail, "input prices: only %d items", (int)prices.size());
    JsonLine amountLine(inf.readLine(), _fail, "input amount");
    long long amount = amountLine.integer(2, 2000000000);
    amountLine.end();

    JsonLine juryLine(ans.readLine(), _fail, "the jury's answer");
    std::vector<long long> jury = juryLine.list(INT_MIN, INT_MAX);
    juryLine.end();
    checkPair(jury, prices, amount, _fail, "the jury's pair");

    JsonLine outLine(ouf.readLine(), _wa, "your output");
    std::vector<long long> pair = outLine.list(INT_MIN, INT_MAX);
    outLine.end();
    checkPair(pair, prices, amount, _wa, "your pair");

    quitf(_ok, "positions %lld and %lld add up to %lld", pair[0], pair[1], amount);
}`,
);

export const EXACT_CHANGE_PAIR: AuthoredProblem = {
  slug: "exact-change-pair",
  displayCode: "REC-0011",
  title: "Exact Change Pair",
  difficulty: "EASY",
  topics: ["ARRAYS_HASHING"],
  statement: `The canteen's snack counter has \`n\` items in a row; item \`i\` costs \`prices[i]\` rupees. You have a meal voucher worth exactly \`amount\` rupees, the counter gives no change, and the voucher must be spent on **exactly two different items**.

Write \`findPair(prices, amount)\` that returns the positions \`[i, j]\` of two items with \`i < j\` and \`prices[i] + prices[j] == amount\`.

Every test has at least one such pair, and often several. Return **any** of them: the judge checks your pair instead of comparing it with one fixed answer.

### Example 1

\`\`\`
Input:  prices = [40, 25, 60, 15, 35], amount = 75
Output: [2, 3]
\`\`\`

\`60 + 15 = 75\`. The pair \`[0, 4]\` (\`40 + 35\`) is accepted as well.

### Example 2

\`\`\`
Input:  prices = [50, 50, 20], amount = 100
Output: [0, 1]
\`\`\`

Two different items may cost the same. Buying one item twice is not allowed: position \`2\` alone cannot make \`[2, 2]\`.

### Note

\`amount\` can be up to 2·10⁹, which does not fit in a 32-bit \`int\`; so can the sum of two prices.`,
  constraints: [
    "2 ≤ prices.length ≤ 2·10⁵",
    "1 ≤ prices[i] ≤ 10⁹",
    "2 ≤ amount ≤ 2·10⁹",
    "At least one pair of different positions adds up to amount.",
  ],
  timeLimitMs: 1000,
  memoryLimitKb: 262_144,
  ioMode: "FUNCTION",
  signature: EXACT_CHANGE_SIGNATURE,
  compareMode: "CHECKER",
  scoringMode: "ICPC",
  stopOnFirstFailure: true,
  checkerSource: EXACT_CHANGE_CHECKER,
  subtasks: [],
  generateTests: exactChangeTests,
  starters: {
    cpp20: starterStub("cpp20", EXACT_CHANGE_SIGNATURE),
    py312: starterStub("py312", EXACT_CHANGE_SIGNATURE),
  },
  references: [
    {
      language: "cpp20",
      label: "Model solution (hash map, one pass)",
      expected: "AC",
      source: `class Solution {
public:
    pair<int, int> findPair(vector<int>& prices, long long amount) {
        unordered_map<long long, int> firstAt;
        firstAt.reserve(prices.size() * 2);
        for (int j = 0; j < (int)prices.size(); ++j) {
            auto it = firstAt.find(amount - prices[j]);
            if (it != firstAt.end()) return {it->second, j};
            firstAt.emplace(prices[j], j);
        }
        return {-1, -1};   // unreachable: every test has a pair
    }
};
`,
    },
    {
      language: "py312",
      label: "Model solution (hash map, one pass)",
      expected: "AC",
      source: `class Solution:
    def findPair(self, prices: List[int], amount: int) -> Tuple[int, int]:
        first_at = {}
        for j, price in enumerate(prices):
            i = first_at.get(amount - price)
            if i is not None:
                return (i, j)
            first_at.setdefault(price, j)
        return (-1, -1)
`,
    },
    {
      language: "java21",
      label: "Model solution (hash map, one pass)",
      expected: "AC",
      source: `class Solution {
    public Pair<Integer, Integer> findPair(int[] prices, long amount) {
        HashMap<Long, Integer> firstAt = new HashMap<>(prices.length * 2);
        for (int j = 0; j < prices.length; j++) {
            Integer i = firstAt.get(amount - prices[j]);
            if (i != null) return new Pair<>(i, j);
            firstAt.putIfAbsent((long) prices[j], j);
        }
        return new Pair<>(-1, -1);
    }
}
`,
    },
    {
      language: "cpp20",
      label: "Deliberately slow: every pair, O(n²)",
      expected: "TLE",
      source: `// Correct, but tries every pair of positions: about n²/2 checks when the
// only pair that works is at the end of the counter.
class Solution {
public:
    pair<int, int> findPair(vector<int>& prices, long long amount) {
        int n = prices.size();
        for (int i = 0; i < n; ++i)
            for (int j = i + 1; j < n; ++j)
                if ((long long)prices[i] + prices[j] == amount) return {i, j};
        return {-1, -1};
    }
};
`,
    },
    {
      language: "py312",
      label: "Deliberately wrong: may buy one item twice",
      expected: "WA",
      source: `# Remembers every price first, then looks for the partner. When a price is
# exactly half the amount, the partner it finds can be the item itself.
class Solution:
    def findPair(self, prices: List[int], amount: int) -> Tuple[int, int]:
        where = {price: i for i, price in enumerate(prices)}
        for i, price in enumerate(prices):
            j = where.get(amount - price)
            if j is not None:
                return (min(i, j), max(i, j))
        return (-1, -1)
`,
    },
  ],
  help: {
    hints: [
      `Trying every pair of items works, but with 2·10⁵ items that is about 2·10¹⁰ pairs. Fix one item instead: if you buy item \`j\`, which price must the other item have?`,
      `Standing at item \`j\`, you need a partner costing exactly \`amount - prices[j]\`, and it is enough to look for it among the items **to the left of** \`j\` — if the pair is \`(i, j)\` with \`i < j\`, you will find it when you reach \`j\`. A hash map from price to position answers "have I already seen this price?" in O(1) on average.`,
      `Walk from left to right. For each \`j\`: look up \`amount - prices[j]\` in the map; if it is there at position \`i\`, return \`[i, j]\`. Otherwise store \`prices[j] → j\` (keeping the first position is fine) and continue. Look up **before** you store: then an item can never pair with itself, while two different items with the same price still work. Do the subtraction in 64 bits — \`amount\` is a \`long long\` in C++ and a \`long\` in Java for a reason.`,
    ],
    editorial: `### Approach

The brute force tries every pair \`(i, j)\` and stops at the first one that adds up. When the only working pair sits at the end of the counter, that is about n²/2 = 2·10¹⁰ checks — far too slow for one second.

**Fix the second item.** If the answer is \`(i, j)\` with \`i < j\`, then when we reach position \`j\` we need a partner costing \`need = amount - prices[j]\`, somewhere to the left. A hash map from price to position answers that in O(1) on average:

1. For \`j = 0, 1, …\`: compute \`need = amount - prices[j]\`.
2. If \`need\` is in the map at position \`i\`, return \`[i, j]\` — \`i < j\` holds automatically because \`i\` was stored earlier.
3. Otherwise store \`prices[j] → j\` and move on.

**Look up before storing.** If item \`j\` were stored first, an item whose price is exactly half the amount would find itself and return \`[j, j]\` — one item bought twice. Looking up first means the map only holds items strictly to the left. Two *different* items with the same price still work: the first one is in the map when the second one arrives.

**Any pair is fine.** A counter can have many valid pairs; the judge checks whether yours adds up, so you do not need to find a particular one.

**Watch the range.** \`amount\` and the sum of two prices can reach 2·10⁹, more than a 32-bit \`int\` holds. Compute \`need\` in 64 bits.

### Complexity

- Time: O(n) on average — one pass with O(1) hash-map operations.
- Memory: O(n) for the map.

(Sorting positions by price and walking two pointers inwards also works, in O(n log n) time.)

### C++

\`\`\`cpp
class Solution {
public:
    pair<int, int> findPair(vector<int>& prices, long long amount) {
        unordered_map<long long, int> firstAt;            // price -> position
        for (int j = 0; j < (int)prices.size(); ++j) {
            auto it = firstAt.find(amount - prices[j]);    // 64-bit subtraction
            if (it != firstAt.end()) return {it->second, j};
            firstAt.emplace(prices[j], j);                 // store AFTER the lookup
        }
        return {-1, -1};                                   // unreachable
    }
};
\`\`\`

### Python

\`\`\`python
class Solution:
    def findPair(self, prices: List[int], amount: int) -> Tuple[int, int]:
        first_at = {}                                      # price -> position
        for j, price in enumerate(prices):
            i = first_at.get(amount - price)
            if i is not None:
                return (i, j)
            first_at.setdefault(price, j)                  # store AFTER the lookup
        return (-1, -1)                                    # unreachable
\`\`\`
`,
  },
};
