/**
 * study-pairs (REC-0003): SUBTASK scoring (20 / 30 / 50, MIN, subtask 3
 * depends on 1 and 2) with a deliberately-TLE brute force. Originally
 * authored for REC Code (Phase 2); hints and editorial added in Phase 3.
 *
 * The tests are byte-identical to the ones the Phase 2 seed wrote.
 */
import { prng, STDIN_STARTERS, type AuthoredProblem, type AuthoredTest } from "./types";

/** Pairs i < j with a_i + a_j ≤ t (sorted two pointers; exact in doubles for these bounds). */
export function comfortablePairs(values: readonly number[], t: number): number {
  const a = [...values].sort((x, y) => x - y);
  let lo = 0;
  let hi = a.length - 1;
  let pairs = 0;
  while (lo < hi) {
    if (a[lo]! + a[hi]! <= t) {
      pairs += hi - lo;
      lo++;
    } else {
      hi--;
    }
  }
  return pairs;
}

function randomInts(n: number, lo: number, hi: number, seed: number): number[] {
  const r = prng(seed);
  return Array.from({ length: n }, () => lo + Math.floor(r() * (hi - lo + 1)));
}

function studyPairsTests(): AuthoredTest[] {
  const B = 1_000_000_000;
  const cases: { values: number[]; t: number; subtask: number; isSample: boolean }[] = [
    { values: [1, 3, 2, 5, 0], t: 4, subtask: 1, isSample: true },
    { values: [-1, 0, -2], t: -1, subtask: 1, isSample: true },
    { values: [7, 7], t: 13, subtask: 1, isSample: false },
    { values: randomInts(2000, -B, B, 11), t: 123_456_789, subtask: 1, isSample: false },
    { values: Array.from({ length: 2000 }, () => 5), t: 10, subtask: 1, isSample: false },
    { values: randomInts(200_000, 0, 1, 21), t: 0, subtask: 2, isSample: false },
    { values: randomInts(200_000, 0, 1, 22), t: 1, subtask: 2, isSample: false },
    { values: randomInts(200_000, 0, 1, 23), t: 2, subtask: 2, isSample: false },
    { values: randomInts(200_000, -B, B, 31), t: 0, subtask: 3, isSample: false },
    { values: randomInts(200_000, -B, B, 32), t: 2 * B, subtask: 3, isSample: false },
    { values: randomInts(200_000, -B, B, 33), t: -2 * B, subtask: 3, isSample: false },
    { values: randomInts(200_000, -50, 50, 34), t: -7, subtask: 3, isSample: false },
  ];
  return cases.map((c) => ({
    isSample: c.isSample,
    subtask: c.subtask,
    input: `${c.values.length} ${c.t}\n${c.values.join(" ")}\n`,
    output: `${comfortablePairs(c.values, c.t)}\n`,
  }));
}

export const STUDY_PAIRS: AuthoredProblem = {
  slug: "study-pairs",
  displayCode: "REC-0003",
  title: "Study Pairs",
  difficulty: "MEDIUM",
  topics: ["TWO_POINTERS", "BINARY_SEARCH"],
  statement: `The placement cell pairs students up for mock interviews. Student \`i\` has a preparation score \`a[i]\`, which is negative for a student who has fallen behind.

Two different students \`i < j\` make a **comfortable pair** when \`a[i] + a[j] ≤ T\`: together they are not too far ahead for the interviewer's question bank.

Count the comfortable pairs.

### Input

The first line contains \`n\` and \`T\`. The second line contains \`a[1] … a[n]\`.

### Output

Print one integer: the number of pairs \`(i, j)\` with \`1 ≤ i < j ≤ n\` and \`a[i] + a[j] ≤ T\`. The answer can exceed 32 bits.

### Subtasks

| Subtask | Points | Extra constraints |
|---|---|---|
| 1 | 20 | \`n ≤ 2000\` |
| 2 | 30 | every \`a[i]\` is 0 or 1 |
| 3 | 50 | none (needs subtasks 1 and 2) |

A subtask earns its points only when every test in it passes. Subtask 3 is judged only after subtasks 1 and 2 are fully solved.

### Example 1

\`\`\`
Input:
5 4
1 3 2 5 0

Output:
5
\`\`\`

The comfortable pairs are the scores (1, 3), (1, 2), (1, 0), (3, 0) and (2, 0).

### Example 2

\`\`\`
Input:
3 -1
-1 0 -2

Output:
3
\`\`\``,
  constraints: ["2 ≤ n ≤ 2·10⁵", "-10⁹ ≤ a[i] ≤ 10⁹", "-2·10⁹ ≤ T ≤ 2·10⁹"],
  timeLimitMs: 1000,
  memoryLimitKb: 262_144,
  ioMode: "STDIN",
  signature: null,
  compareMode: "TOKEN",
  scoringMode: "SUBTASK",
  stopOnFirstFailure: false,
  checkerSource: null,
  subtasks: [
    { index: 1, points: 20, dependsOn: [] },
    { index: 2, points: 30, dependsOn: [] },
    { index: 3, points: 50, dependsOn: [1, 2] },
  ],
  generateTests: studyPairsTests,
  starters: STDIN_STARTERS,
  references: [
    {
      language: "cpp20",
      label: "Model solution (sort + two pointers)",
      expected: "AC",
      source: `#include <bits/stdc++.h>
using namespace std;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);
    int n;
    long long t;
    cin >> n >> t;
    vector<long long> a(n);
    for (auto& x : a) cin >> x;
    sort(a.begin(), a.end());
    long long pairs = 0;
    int lo = 0, hi = n - 1;
    while (lo < hi) {
        if (a[lo] + a[hi] <= t) {
            pairs += hi - lo;
            ++lo;
        } else {
            --hi;
        }
    }
    cout << pairs << '\\n';
    return 0;
}
`,
    },
    {
      language: "py312",
      label: "Model solution (sort + two pointers)",
      expected: "AC",
      source: `import sys


def main():
    data = sys.stdin.buffer.read().split()
    n, t = int(data[0]), int(data[1])
    a = sorted(map(int, data[2:2 + n]))
    lo, hi = 0, n - 1
    pairs = 0
    while lo < hi:
        if a[lo] + a[hi] <= t:
            pairs += hi - lo
            lo += 1
        else:
            hi -= 1
    print(pairs)


main()
`,
    },
    {
      language: "cpp20",
      label: "Deliberately slow: every pair, O(n²)",
      expected: "TLE",
      source: `#include <bits/stdc++.h>
using namespace std;

// Checks every pair: fine for subtask 1 (n <= 2000), far too slow beyond it.
int main() {
    int n;
    long long t;
    if (scanf("%d %lld", &n, &t) != 2) return 0;
    vector<long long> a(n);
    for (auto& x : a) scanf("%lld", &x);
    long long pairs = 0;
    for (int i = 0; i < n; ++i)
        for (int j = i + 1; j < n; ++j)
            if (a[i] + a[j] <= t) ++pairs;
    printf("%lld\\n", pairs);
    return 0;
}
`,
    },
  ],
  help: {
    hints: [
      `The order of the students does not change the answer: the pair \`{i, j}\` counts once whichever way round you look at it. What becomes easier if you sort the scores first?`,
      `Sort the scores and put one pointer on the smallest (\`lo\`) and one on the largest (\`hi\`). If \`a[lo] + a[hi] ≤ T\`, then \`a[lo]\` also pairs comfortably with *every* score between \`lo + 1\` and \`hi\`, because those are no larger than \`a[hi]\` — that is \`hi - lo\` pairs counted in one step.`,
      `While \`lo < hi\`: if \`a[lo] + a[hi] ≤ T\`, add \`hi - lo\` to the answer and move \`lo\` right; otherwise \`a[hi]\` is too big for every remaining partner, so move \`hi\` left. Use 64-bit integers for the scores' sum (it reaches ±2·10⁹) and for the count (up to about 2·10¹⁰).`,
    ],
    editorial: `### Approach

**Subtask 1 (n ≤ 2000).** Checking every pair is about 2·10⁶ additions — fast enough, and a good way to make sure you understand the question. With \`n = 2·10⁵\` it would be 2·10¹⁰ checks, far too slow.

**Subtask 2 (scores are 0 or 1).** Count the zeros \`z\` and the ones \`o\`. A pair sums to 0, 1 or 2, so the answer is a formula: 0 pairs if \`T < 0\`; \`z(z−1)/2\` if \`T = 0\`; \`z(z−1)/2 + z·o\` if \`T = 1\`; all \`n(n−1)/2\` pairs if \`T ≥ 2\`.

**Full solution.** Which student is \`i\` and which is \`j\` does not matter for the count, so **sort** the scores. Now use two pointers, \`lo\` at the smallest score and \`hi\` at the largest:

- If \`a[lo] + a[hi] ≤ T\`, every score between \`lo + 1\` and \`hi\` is at most \`a[hi]\`, so \`a[lo]\` makes a comfortable pair with **all** of them: add \`hi − lo\` and move \`lo\` one step right.
- Otherwise \`a[hi]\` is too large even for the smallest remaining score, so it pairs with nobody left: move \`hi\` one step left.

Each step moves one pointer, so after at most \`n\` steps they meet and every pair has been counted exactly once.

An equally good alternative: after sorting, for each \`i\` **binary search** the last \`j > i\` with \`a[i] + a[j] ≤ T\` and add \`j − i\`. That is also O(n log n).

**Watch the range.** Scores are up to ±10⁹, so a sum reaches ±2·10⁹ (outside a 32-bit \`int\`), and the answer can be about 2·10¹⁰. Use \`long long\` in C++.

### Complexity

- Time: O(n log n) for the sort; the two-pointer walk is O(n).
- Memory: O(n) for the scores.

### C++

\`\`\`cpp
#include <bits/stdc++.h>
using namespace std;

int main() {
    int n;
    long long t;
    cin >> n >> t;
    vector<long long> a(n);
    for (auto& x : a) cin >> x;
    sort(a.begin(), a.end());
    long long pairs = 0;
    int lo = 0, hi = n - 1;
    while (lo < hi) {
        if (a[lo] + a[hi] <= t) { pairs += hi - lo; ++lo; }
        else --hi;
    }
    cout << pairs << '\\n';
}
\`\`\`

### Python

\`\`\`python
import sys

def main():
    data = sys.stdin.buffer.read().split()
    n, t = int(data[0]), int(data[1])
    a = sorted(map(int, data[2:2 + n]))
    lo, hi, pairs = 0, n - 1, 0
    while lo < hi:
        if a[lo] + a[hi] <= t:
            pairs += hi - lo
            lo += 1
        else:
            hi -= 1
    print(pairs)

main()
\`\`\`
`,
  },
};
