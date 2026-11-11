/**
 * no-neighbour-seating (REC-0012): FUNCTION mode, EASY, CUSTOM_CHECKER.
 * Originally authored for REC Code: seat a lab exam so that no two students
 * with consecutive roll numbers sit side by side. Any valid seating is
 * accepted, judged by a testlib checker.
 */
import { parseType, serializeArgs, serializeValue, starterStub, type FunctionSignature } from "@recx/shared/harness";
import { functionChecker } from "./checker-json";
import type { AuthoredProblem, AuthoredTest } from "./types";

export const NO_NEIGHBOUR_SIGNATURE: FunctionSignature = {
  className: "Solution",
  methodName: "arrangeSeats",
  params: [{ name: "n", type: "int" }],
  returns: "list<int>",
  comparator: "CUSTOM_CHECKER",
  mutatedParam: null,
};

export const NO_NEIGHBOUR_LIMITS = Object.freeze({ maxN: 100_000 });

/** The jury's seating: the even roll numbers in increasing order, then the odd ones. */
export function seatingFor(n: number): number[] {
  const evens = Array.from({ length: Math.floor(n / 2) }, (_, i) => 2 * (i + 1));
  const odds = Array.from({ length: Math.ceil(n / 2) }, (_, i) => 2 * i + 1);
  return [...evens, ...odds];
}

/** The checker's rule: every roll number 1..n once, and no neighbours that differ by exactly 1. */
export function isValidSeating(n: number, seats: readonly number[]): boolean {
  if (seats.length !== n) return false;
  const seen = new Set<number>();
  for (const s of seats) {
    if (!Number.isInteger(s) || s < 1 || s > n || seen.has(s)) return false;
    seen.add(s);
  }
  return seats.every((s, i) => i === 0 || Math.abs(s - seats[i - 1]!) !== 1);
}

const N = parseType(NO_NEIGHBOUR_SIGNATURE.params[0]!.type);
const RETURNS = parseType(NO_NEIGHBOUR_SIGNATURE.returns);

function noNeighbourTests(): AuthoredTest[] {
  const { maxN } = NO_NEIGHBOUR_LIMITS;
  const cases: { n: number; isSample: boolean }[] = [
    { n: 5, isSample: true },
    { n: 1, isSample: true },
    // The smallest row with two or more students — and the only n where
    // "odd roll numbers first, then even" puts 3 next to 2.
    { n: 4, isSample: false },
    { n: 6, isSample: false },
    { n: 7, isSample: false },
    { n: 8, isSample: false },
    { n: 9, isSample: false },
    { n: 10, isSample: false },
    { n: 11, isSample: false },
    { n: 64, isSample: false },
    { n: 999, isSample: false },
    { n: 4096, isSample: false },
    { n: maxN - 1, isSample: false },
    { n: maxN, isSample: false },
  ];
  return cases.map(({ n, isSample }) => ({
    isSample,
    subtask: null,
    input: serializeArgs([N], [n]),
    output: serializeValue(RETURNS, seatingFor(n)) + "\n",
  }));
}

const NO_NEIGHBOUR_CHECKER = functionChecker(
  String.raw`// no-neighbour-seating: accept ANY seating of the roll numbers 1..n, each
// exactly once, in which no two neighbouring seats hold numbers that differ
// by exactly 1.
//   input.txt   line 1: n
//   answer.txt  the jury's seating (checked as well: a bad one is FAIL, not WA)
//   output.txt  the contestant's seating`,
  String.raw`void checkSeating(const std::vector<long long>& seats, int n, TResult verdict, const char* who) {
    if ((long long)seats.size() != n) {
        quitf(verdict, "%s has %d seats, but there are %d students", who, (int)seats.size(), n);
    }
    std::vector<char> seated(n + 1, 0);
    for (int i = 0; i < n; ++i) {
        long long s = seats[i];
        if (s < 1 || s > n) quitf(verdict, "%s: seat %d holds %lld, but roll numbers are 1..%d", who, i, s, n);
        if (seated[s]) quitf(verdict, "%s seats roll number %lld twice", who, s);
        seated[s] = 1;
        if (i > 0 && (seats[i - 1] - s == 1 || s - seats[i - 1] == 1)) {
            quitf(verdict, "%s puts roll numbers %lld and %lld side by side (seats %d and %d)", who, seats[i - 1], s, i - 1, i);
        }
    }
}

int main(int argc, char* argv[]) {
    registerTestlibCmd(argc, argv);

    JsonLine nLine(inf.readLine(), _fail, "input n");
    int n = (int)nLine.integer(1, 100000);
    nLine.end();
    if (n == 2 || n == 3) quitf(_fail, "input n: no valid seating exists for n = %d", n);

    JsonLine juryLine(ans.readLine(), _fail, "the jury's answer");
    std::vector<long long> jury = juryLine.list(INT_MIN, INT_MAX);
    juryLine.end();
    checkSeating(jury, n, _fail, "the jury's seating");

    JsonLine outLine(ouf.readLine(), _wa, "your output");
    std::vector<long long> seats = outLine.list(INT_MIN, INT_MAX);
    outLine.end();
    checkSeating(seats, n, _wa, "your seating");

    quitf(_ok, "a valid seating of %d students", n);
}`,
);

export const NO_NEIGHBOUR_SEATING: AuthoredProblem = {
  slug: "no-neighbour-seating",
  displayCode: "REC-0012",
  title: "No Neighbours Seating",
  difficulty: "EASY",
  topics: ["MATH_BITS", "GREEDY"],
  statement: `For a lab exam, \`n\` students with roll numbers \`1\` to \`n\` sit in one long row of \`n\` seats. Students with consecutive roll numbers usually prepared together, so the invigilator never seats them side by side: two neighbouring seats must not hold roll numbers that differ by exactly \`1\`.

Write \`arrangeSeats(n)\` that returns a seating: a list of the roll numbers \`1\` to \`n\`, each exactly once, read from the first seat to the last, in which no two neighbours have consecutive roll numbers.

Such a seating exists for \`n = 1\` and for every \`n ≥ 4\`, and the tests only use those values. When several seatings work, return **any** of them: the judge checks your seating instead of comparing it with one fixed answer.

### Example 1

\`\`\`
Input:  n = 5
Output: [2, 4, 1, 3, 5]
\`\`\`

The neighbours differ by 2, 3, 2 and 2. \`[3, 1, 4, 2, 5]\` is also accepted; \`[1, 3, 5, 4, 2]\` is not, because 5 and 4 sit side by side.

### Example 2

\`\`\`
Input:  n = 1
Output: [1]
\`\`\`

A single student has no neighbours.`,
  constraints: ["1 ≤ n ≤ 10⁵", "n is not 2 or 3 (no valid seating exists for them)."],
  timeLimitMs: 1000,
  memoryLimitKb: 262_144,
  ioMode: "FUNCTION",
  signature: NO_NEIGHBOUR_SIGNATURE,
  compareMode: "CHECKER",
  scoringMode: "ICPC",
  stopOnFirstFailure: true,
  checkerSource: NO_NEIGHBOUR_CHECKER,
  subtasks: [],
  generateTests: noNeighbourTests,
  starters: {
    cpp20: starterStub("cpp20", NO_NEIGHBOUR_SIGNATURE),
    py312: starterStub("py312", NO_NEIGHBOUR_SIGNATURE),
  },
  references: [
    {
      language: "cpp20",
      label: "Model solution (evens, then odds)",
      expected: "AC",
      source: `class Solution {
public:
    vector<int> arrangeSeats(int n) {
        vector<int> seats;
        seats.reserve(n);
        for (int r = 2; r <= n; r += 2) seats.push_back(r);
        for (int r = 1; r <= n; r += 2) seats.push_back(r);
        return seats;
    }
};
`,
    },
    {
      language: "py312",
      label: "Model solution (evens, then odds)",
      expected: "AC",
      source: `class Solution:
    def arrangeSeats(self, n: int) -> List[int]:
        return list(range(2, n + 1, 2)) + list(range(1, n + 1, 2))
`,
    },
    {
      language: "java21",
      label: "Model solution (evens, then odds)",
      expected: "AC",
      source: `class Solution {
    public int[] arrangeSeats(int n) {
        int[] seats = new int[n];
        int k = 0;
        for (int r = 2; r <= n; r += 2) seats[k++] = r;
        for (int r = 1; r <= n; r += 2) seats[k++] = r;
        return seats;
    }
}
`,
    },
    {
      language: "cpp20",
      label: "Deliberately wrong: odds, then evens",
      expected: "WA",
      source: `// Odd roll numbers first, then even ones. Inside each half the neighbours
// differ by 2, but at the join the last odd number meets 2: for n = 4 that
// puts 3 next to 2.
class Solution {
public:
    vector<int> arrangeSeats(int n) {
        vector<int> seats;
        for (int r = 1; r <= n; r += 2) seats.push_back(r);
        for (int r = 2; r <= n; r += 2) seats.push_back(r);
        return seats;
    }
};
`,
    },
  ],
  help: {
    hints: [
      `Split the roll numbers by **parity**. Two even numbers never differ by exactly 1, and neither do two odd numbers. What happens if every even roll number sits in one block of seats and every odd roll number in another?`,
      `Inside a block of only even (or only odd) numbers in increasing order, neighbours differ by 2, which is safe. The only risky spot is the **join**, where the last number of the first block meets the first number of the second block. Choose the order of the two blocks so that the join is safe for every allowed \`n\` — and check \`n = 4\` and \`n = 5\` by hand.`,
      `Seat the evens first, \`2, 4, 6, …\`, then the odds, \`1, 3, 5, …\`. The join puts the largest even number, at least 4 when \`n ≥ 4\`, next to \`1\`: they differ by at least 3. The other order, odds then evens, puts the largest odd number next to \`2\`. That works for most \`n\`, but for \`n = 4\` it gives \`1, 3, 2, 4\`, with 3 next to 2. And \`n = 1\` needs no special case: the evens block is empty and the answer is \`[1]\`.`,
    ],
    editorial: `### Approach

**Group by parity.** Two numbers that differ by exactly 1 always have different parities: one is even and one is odd. So a block of only even roll numbers, in increasing order, is safe inside — its neighbours differ by 2 — and so is a block of only odd roll numbers.

Putting the two blocks one after the other leaves exactly one place to check: the **join**.

- **Evens, then odds:** \`2, 4, …, E, 1, 3, …\`, where \`E\` is the largest even number up to \`n\`. At the join, \`E\` meets \`1\`. For \`n ≥ 4\`, \`E ≥ 4\`, so they differ by at least 3. Safe.
- **Odds, then evens:** \`1, 3, …, O, 2, 4, …\`, where \`O\` is the largest odd number up to \`n\`. At the join, \`O\` meets \`2\`. For \`n ≥ 5\`, \`O ≥ 5\` and that is safe, but for \`n = 4\`, \`O = 3\` and the seating \`1, 3, 2, 4\` puts 3 next to 2. This order fails exactly one allowed \`n\` — a good reminder to test the smallest cases.

For \`n = 1\` the evens block is empty and the answer is \`[1]\`.

**Why are 2 and 3 impossible?** With two students, \`1\` and \`2\` must sit together. With three, \`2\` differs by 1 from both \`1\` and \`3\`, so whoever sits next to \`2\` is consecutive with it — and \`2\` always has at least one neighbour.

The checker accepts any valid seating, so other constructions are fine too.

### Complexity

- Time: O(n) — each roll number is written once.
- Memory: O(n) for the answer.

### C++

\`\`\`cpp
class Solution {
public:
    vector<int> arrangeSeats(int n) {
        vector<int> seats;
        for (int r = 2; r <= n; r += 2) seats.push_back(r);   // evens first
        for (int r = 1; r <= n; r += 2) seats.push_back(r);   // then odds; the join is E next to 1
        return seats;
    }
};
\`\`\`

### Python

\`\`\`python
class Solution:
    def arrangeSeats(self, n: int) -> List[int]:
        return list(range(2, n + 1, 2)) + list(range(1, n + 1, 2))
\`\`\`
`,
  },
};
