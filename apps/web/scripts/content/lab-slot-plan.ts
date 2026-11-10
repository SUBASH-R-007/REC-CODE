/**
 * lab-slot-plan (REC-0013): STDIN mode, MEDIUM, Dynamic Programming.
 * Originally authored for REC Code: book lab slots to clear the most
 * backlog, leaving a fixed write-up gap between sessions.
 *
 * Why this problem, and why this shape. Four of the fourteen `TOPICS` had
 * no authored problem at all — TREES, HEAPS, BACKTRACKING and
 * DYNAMIC_PROGRAMMING — so a student filtering the catalogue by any of
 * them met an empty page. This is the first of those four.
 *
 * The gap `c` is an INPUT rather than a constant, and that is the whole
 * design. With `c = 1` this is the recurrence every student has seen
 * written out somewhere; with `c` read from the file, a remembered answer
 * does not survive, and the student has to say what "the last slot I could
 * have used" means. The samples are chosen so `c = 1` and `c = 2` both
 * appear before any hidden test runs.
 */
import { STDIN_STARTERS, prng, randomInt, type AuthoredProblem, type AuthoredTest } from "./types";

export const LAB_SLOT_LIMITS = Object.freeze({
  maxN: 200_000,
  maxCleared: 1_000_000_000,
});

/**
 * The jury's answer: one pass, O(n) time and O(n) memory.
 *
 * `best[i]` is the most that can be cleared using only the first `i` slots.
 * Either slot `i` is not booked (`best[i - 1]`), or it is, and then the
 * previous session ended at or before `i - c - 1`, because `c` slots have
 * to be free in between.
 *
 * Numbers: 2·10⁵ slots clearing 10⁹ each is 10¹⁴ at most — outside a
 * 32-bit int, inside a float64's exact range (< 2⁵³), so the reference can
 * stay in `number`.
 */
export function bestCleared(cleared: readonly number[], gap: number): number {
  const n = cleared.length;
  const best = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    const earlier = i - gap - 1;
    const take = cleared[i - 1]! + (earlier >= 0 ? best[earlier]! : 0);
    best[i] = Math.max(best[i - 1]!, take);
  }
  return best[n]!;
}

/** A fresh stream per call would repeat; one stream, n draws. */
function stream(n: number, lo: number, hi: number, seed: number): number[] {
  const r = prng(seed);
  return Array.from({ length: n }, () => randomInt(r, lo, hi));
}

/**
 * The case a greedy fails on: the biggest value sits in the middle, and
 * taking it costs both of its neighbours. `[3, 4, 3]` with `c = 1` is 6 by
 * the recurrence and 4 by "take the largest you can".
 */
function greedyTrap(blocks: number, seed: number): number[] {
  const r = prng(seed);
  const out: number[] = [];
  for (let i = 0; i < blocks; i++) {
    const side = randomInt(r, 3, 1_000);
    out.push(side, 2 * side - 1, side);
  }
  return out;
}

function labSlotTests(): AuthoredTest[] {
  const { maxN, maxCleared } = LAB_SLOT_LIMITS;
  const cases: { cleared: number[]; gap: number; isSample: boolean }[] = [
    // Sample 1: the gap is one, and the two ends beat the three odd slots.
    { cleared: [4, 1, 1, 9, 1], gap: 1, isSample: true },
    // Sample 2: a wider gap, so only two of six slots can ever be booked.
    { cleared: [5, 5, 5, 5, 5, 5], gap: 2, isSample: true },
    // One slot, and it is worth booking.
    { cleared: [7], gap: 1, isSample: false },
    // One slot worth nothing: the answer is 0, not "something must be booked".
    { cleared: [0], gap: 1, isSample: false },
    // The gap is the whole day: at most one session, so the answer is the
    // largest single slot — and it is not the first or the last.
    { cleared: [2, 9, 3, 4], gap: 4, isSample: false },
    // Everything is zero: the answer is 0 however many slots are booked.
    { cleared: [0, 0, 0, 0, 0], gap: 1, isSample: false },
    // Greedy takes the 4 and scores 4; the recurrence takes both 3s.
    { cleared: [3, 4, 3], gap: 1, isSample: false },
    // The same trap with the wider gap, where the greedy choice is worse again.
    { cleared: [5, 6, 5, 5, 6, 5], gap: 2, isSample: false },
    // Two slots and a gap of one: book the better of them.
    { cleared: [1_000_000_000, 999_999_999], gap: 1, isSample: false },
    // 32 bits is not enough: 10⁵ bookings of 10⁹ is exactly 10¹⁴.
    { cleared: Array.from({ length: maxN }, () => maxCleared), gap: 1, isSample: false },
    // The widest gap at full size: one booking, and the biggest value is in
    // the middle so neither end is the answer.
    {
      cleared: Array.from({ length: maxN }, (_v, i) => (i === maxN >> 1 ? maxCleared : 1)),
      gap: maxN,
      isSample: false,
    },
    // Full size, gap one, random: the ordinary case at the limit.
    { cleared: stream(maxN, 0, maxCleared, 20_261_110), gap: 1, isSample: false },
    // Full size with a middling gap, where the index arithmetic is easiest
    // to get wrong by one.
    { cleared: stream(maxN, 0, maxCleared, 20_261_111), gap: 7, isSample: false },
    // Full size with a gap just under n: two bookings at most.
    { cleared: stream(maxN, 1, maxCleared, 20_261_112), gap: maxN - 2, isSample: false },
    // The greedy trap at scale.
    { cleared: greedyTrap(Math.floor(maxN / 3), 20_261_113), gap: 1, isSample: false },
    // Small random, every gap from 1 to 6, so an off-by-one in `i - c - 1`
    // has nowhere to hide.
    ...[1, 2, 3, 4, 5, 6].map((gap) => ({
      cleared: stream(40, 0, 50, 20_261_120 + gap),
      gap,
      isSample: false,
    })),
  ];

  return cases.map(({ cleared, gap, isSample }) => ({
    isSample,
    subtask: null,
    input: `${cleared.length} ${gap}\n${cleared.join(" ")}\n`,
    output: `${bestCleared(cleared, gap)}\n`,
  }));
}

export const LAB_SLOT_PLAN: AuthoredProblem = {
  slug: "lab-slot-plan",
  displayCode: "REC-0013",
  title: "Lab slot plan",
  difficulty: "MEDIUM",
  topics: ["DYNAMIC_PROGRAMMING"],
  statement: `The lab is open in \`n\` one-hour slots today, numbered \`1\` to \`n\`. Booking slot \`i\` clears \`v[i]\` items from your backlog.

There is one rule. After a session you have to write it up before you book another, so **at least \`c\` slots must be free between two bookings**: if you book slot \`i\` and then slot \`j\`, then \`j ≥ i + c + 1\`.

Book any set of slots that obeys the rule — including none at all — and clear as much as you can.

### Input

The first line contains \`n\` and \`c\`. The second line contains \`v[1] … v[n]\`.

### Output

Print one integer: the largest total you can clear. The answer can exceed 32 bits.

### Example 1

\`\`\`
Input:
5 1
4 1 1 9 1

Output:
13
\`\`\`

Slots 1 and 4 clear \`4 + 9 = 13\`. Slot 3 cannot join them: slots 3 and 4 would be next to each other, with nothing free in between. Booking 1, 3 and 5 instead clears only \`4 + 1 + 1 = 6\`.

### Example 2

\`\`\`
Input:
6 2
5 5 5 5 5 5

Output:
10
\`\`\`

Two slots at least three apart is the most that fit — 1 and 4, or 1 and 5, or 2 and 6, and so on — so the answer is \`5 + 5\`.`,
  constraints: ["1 ≤ n ≤ 2·10⁵", "1 ≤ c ≤ n", "0 ≤ v[i] ≤ 10⁹"],
  timeLimitMs: 1000,
  memoryLimitKb: 262_144,
  ioMode: "STDIN",
  signature: null,
  compareMode: "TOKEN",
  scoringMode: "ICPC",
  stopOnFirstFailure: false,
  checkerSource: null,
  subtasks: [],
  generateTests: labSlotTests,
  starters: STDIN_STARTERS,
  references: [
    {
      language: "cpp20",
      label: "Model solution (one pass, O(n))",
      expected: "AC",
      source: `#include <bits/stdc++.h>
using namespace std;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);
    long long n, c;
    cin >> n >> c;
    vector<long long> v(n + 1);
    for (long long i = 1; i <= n; ++i) cin >> v[i];

    // best[i] = the most clearable using only the first i slots.
    vector<long long> best(n + 1, 0);
    for (long long i = 1; i <= n; ++i) {
        long long earlier = i - c - 1;
        long long take = v[i] + (earlier >= 0 ? best[earlier] : 0);
        best[i] = max(best[i - 1], take);
    }
    cout << best[n] << "\\n";
    return 0;
}
`,
    },
    {
      language: "py312",
      label: "Model solution (one pass, O(n))",
      expected: "AC",
      source: `import sys


def main():
    data = sys.stdin.buffer.read().split()
    n = int(data[0])
    c = int(data[1])
    v = list(map(int, data[2 : 2 + n]))

    best = [0] * (n + 1)
    for i in range(1, n + 1):
        earlier = i - c - 1
        take = v[i - 1] + (best[earlier] if earlier >= 0 else 0)
        best[i] = best[i - 1] if best[i - 1] > take else take
    print(best[n])


main()
`,
    },
    {
      language: "cpp20",
      label: "Greedy: book the biggest slot that still fits (WRONG)",
      expected: "WA",
      source: `#include <bits/stdc++.h>
using namespace std;

// Takes the largest remaining slot and blocks its neighbours. It fails on
// [3, 4, 3] with c = 1: it scores 4 where the answer is 6.
int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);
    long long n, c;
    cin >> n >> c;
    vector<long long> v(n);
    for (auto &x : v) cin >> x;

    vector<pair<long long, long long>> order;
    order.reserve(n);
    for (long long i = 0; i < n; ++i) order.push_back({v[i], i});
    sort(order.rbegin(), order.rend());

    vector<char> blocked(n, 0);
    long long total = 0;
    for (auto [value, at] : order) {
        if (blocked[at]) continue;
        total += value;
        for (long long j = max<long long>(0, at - c); j <= min<long long>(n - 1, at + c); ++j) blocked[j] = 1;
    }
    cout << total << "\\n";
    return 0;
}
`,
    },
    {
      language: "cpp20",
      label: "Quadratic DP: a maximum over every earlier slot (TOO SLOW)",
      expected: "TLE",
      source: `#include <bits/stdc++.h>
using namespace std;

// The right recurrence, read the wrong way round: it scans every earlier
// slot instead of noticing that best[] is already a running maximum.
int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);
    long long n, c;
    cin >> n >> c;
    vector<long long> v(n + 1);
    for (long long i = 1; i <= n; ++i) cin >> v[i];

    vector<long long> best(n + 1, 0);
    for (long long i = 1; i <= n; ++i) {
        long long take = v[i];
        for (long long j = 0; j + c + 1 <= i; ++j) take = max(take, v[i] + best[j]);
        best[i] = max(best[i - 1], take);
    }
    cout << best[n] << "\\n";
    return 0;
}
`,
    },
  ],
  help: {
    hints: [
      `Decide one slot at a time, from the left. Standing at slot \`i\`, there are only two things you can do: leave it free, or book it. If you leave it free, you are facing the same question about the first \`i - 1\` slots. If you book it, which slots are still available behind you?`,
      `Let \`best[i]\` be the most you can clear using only slots \`1 … i\`. Leaving slot \`i\` free gives \`best[i - 1]\`. Booking it gives \`v[i]\` plus the best you could do up to the last slot that is far enough back — and "far enough back" is exactly what \`c\` tells you. Write that index down before you write any code; it is where this problem is usually lost.`,
      `\`best[i] = max(best[i - 1], v[i] + best[i - c - 1])\`, with \`best[j] = 0\` for any \`j ≤ 0\`. One pass from left to right, constant work per slot, and the answer is \`best[n]\`. Three things to get right. The index is \`i - c - 1\` and not \`i - c\`, because \`c\` slots have to be FREE between two bookings. It goes negative for the early slots, so treat any \`best[j]\` with \`j ≤ 0\` as 0 rather than reading off the end. And the total reaches \`2·10⁵ × 10⁹ / 2 = 10¹⁴\`, which overflows a 32-bit accumulator silently and prints a negative number — use \`long long\` in C++.`,
    ],
    editorial: `### Approach

Work left to right and ask one question per slot: **is slot \`i\` booked?**

Let \`best[i]\` be the most that can be cleared using only the first \`i\` slots. There are exactly two cases.

- Slot \`i\` is **not** booked. Then nothing about it matters and the answer is \`best[i - 1]\`.
- Slot \`i\` **is** booked. It clears \`v[i]\`, and the rule says the previous booking was at slot \`i - c - 1\` or earlier. "Or earlier" is the part that makes this cheap: \`best\` is already the best over *all* earlier prefixes, so the previous booking contributes \`best[i - c - 1]\` and nothing has to be searched.

So

\`\`\`
best[i] = max(best[i - 1], v[i] + best[i - c - 1])     best[j] = 0 for j ≤ 0
\`\`\`

and the answer is \`best[n]\`.

### The two traps

**The index.** \`i - c - 1\`, not \`i - c\`. The rule is that \`c\` slots are *free* between two bookings, so slot \`i\` and slot \`i - c - 1\` have exactly \`c\` slots between them. Reading it as \`i - c\` allows two bookings with \`c - 1\` slots free, which the samples do not catch when \`c = 1\` — that is why Example 2 uses \`c = 2\`.

**The range.** \`2·10⁵\` slots, \`10⁹\` each, and up to half of them bookable: \`10¹⁴\`. A 32-bit accumulator overflows silently and prints a negative number.

### Why a greedy fails

"Book the biggest slot that still fits, then block its neighbours" is a tempting rule and it is wrong. On \`[3, 4, 3]\` with \`c = 1\` it books the 4 and blocks both 3s, scoring 4; the answer is 6. The hidden tests include that shape at full size, because a greedy is fast enough to pass on time and still be wrong.

### Why the loop is not nested

The same recurrence is often written as "the maximum over every \`j\` with \`j + c + 1 ≤ i\`", which is \`O(n²)\` and times out at \`n = 2·10⁵\`. It is not needed: \`best\` is non-decreasing, so the maximum over all those \`j\` IS \`best[i - c - 1]\`.

### Complexity

- Time: O(n) — one pass, constant work per slot.
- Memory: O(n) for \`best\`. It can be O(c) with a ring buffer, which is not needed here.

### C++

\`\`\`cpp
long long n, c;
cin >> n >> c;
vector<long long> v(n + 1);
for (long long i = 1; i <= n; ++i) cin >> v[i];

vector<long long> best(n + 1, 0);
for (long long i = 1; i <= n; ++i) {
    long long earlier = i - c - 1;
    long long take = v[i] + (earlier >= 0 ? best[earlier] : 0);
    best[i] = max(best[i - 1], take);
}
cout << best[n] << "\\n";
\`\`\`

### Python

\`\`\`python
best = [0] * (n + 1)
for i in range(1, n + 1):
    earlier = i - c - 1
    take = v[i - 1] + (best[earlier] if earlier >= 0 else 0)
    best[i] = max(best[i - 1], take)
print(best[n])
\`\`\`
`,
  },
};
