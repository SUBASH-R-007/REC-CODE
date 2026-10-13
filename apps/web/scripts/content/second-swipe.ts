/**
 * second-swipe (REC-0006): STDIN mode, EASY, Arrays & Hashing. Originally
 * authored for REC Code: find the first library-gate swipe that repeats a
 * card already seen that day.
 */
import { prng, randomInt, STDIN_STARTERS, type AuthoredProblem, type AuthoredTest } from "./types";

export const SECOND_SWIPE_LIMITS = Object.freeze({ maxN: 200_000, maxCard: 1_000_000_000 });

/** The first swipe (1-based) whose card was already seen, or null when every card is unique. */
export function firstRepeat(cards: readonly number[]): { card: number; position: number } | null {
  const seen = new Set<number>();
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i]!;
    if (seen.has(card)) return { card, position: i + 1 };
    seen.add(card);
  }
  return null;
}

/** `n` distinct random cards in [1, maxCard]. */
function distinctCards(n: number, seed: number): number[] {
  const r = prng(seed);
  const seen = new Set<number>();
  const out: number[] = [];
  while (out.length < n) {
    const card = randomInt(r, 1, SECOND_SWIPE_LIMITS.maxCard);
    if (seen.has(card)) continue;
    seen.add(card);
    out.push(card);
  }
  return out;
}

/**
 * Distinct cards with two planted repeats that set a trap: card A is seen
 * first (early) but repeats late, card B is seen later but repeats sooner.
 * The first repeating swipe is B's; "the repeated card seen first" is A.
 */
function trapCards(n: number, seed: number): number[] {
  const cards = distinctCards(n, seed);
  const a = cards[10]!;
  const b = cards[1000]!;
  cards[n - 10] = a;
  cards[50_000] = b;
  return cards;
}

function randomCards(n: number, maxCard: number, seed: number): number[] {
  const r = prng(seed);
  return Array.from({ length: n }, () => randomInt(r, 1, maxCard));
}

function secondSwipeTests(): AuthoredTest[] {
  const { maxN, maxCard } = SECOND_SWIPE_LIMITS;
  const ascending = Array.from({ length: maxN }, (_, i) => 1000 + 3 * i);
  ascending[maxN - 1] = ascending[maxN - 2]!;
  const middlePair = distinctCards(maxN, 64);
  middlePair[100_001] = middlePair[100_000]!;
  const lastRepeatsFirst = distinctCards(maxN, 62);
  lastRepeatsFirst[maxN - 1] = lastRepeatsFirst[0]!;

  const cases: { cards: number[]; isSample: boolean }[] = [
    { cards: [41, 7, 19, 7, 41, 3], isSample: true },
    { cards: [5, 6, 8], isSample: true },
    { cards: [9], isSample: false },
    { cards: [4, 4], isSample: false },
    { cards: [1, 2, 3, 4, 5, 1], isSample: false },
    { cards: [10, 20, 30, 20, 10], isSample: false },
    { cards: [maxCard, 1, maxCard], isSample: false },
    { cards: distinctCards(maxN, 61), isSample: false },
    { cards: lastRepeatsFirst, isSample: false },
    { cards: trapCards(maxN, 63), isSample: false },
    { cards: middlePair, isSample: false },
    { cards: ascending, isSample: false },
    { cards: randomCards(maxN, maxCard, 65), isSample: false },
    { cards: randomCards(maxN, 1000, 66), isSample: false },
  ];
  return cases.map(({ cards, isSample }) => {
    const found = firstRepeat(cards);
    return {
      isSample,
      subtask: null,
      input: `${cards.length}\n${cards.join(" ")}\n`,
      output: found ? `${found.card} ${found.position}\n` : "-1\n",
    };
  });
}

export const SECOND_SWIPE: AuthoredProblem = {
  slug: "second-swipe",
  displayCode: "REC-0006",
  title: "Second Swipe",
  difficulty: "EASY",
  topics: ["ARRAYS_HASHING"],
  statement: `The library gate records the ID card number of every swipe, in order. Each card should be swiped only once a day, so the gate raises an alert at the **first swipe that repeats a card already seen today**.

Given the day's swipes, find that swipe. Print the card number and the position of the swipe (swipes are numbered from 1). If no card is swiped twice, print \`-1\`.

Careful: the alert is about the first *moment* a repeat happens. That is not always the repeated card that was seen first.

### Input

The first line contains \`n\`, the number of swipes. The second line contains the card numbers \`c[1] … c[n]\`.

### Output

Print two integers — the repeated card number and the position of the swipe that repeated it — or \`-1\` if every card is swiped at most once.

### Example 1

\`\`\`
Input:
6
41 7 19 7 41 3

Output:
7 4
\`\`\`

Card 41 repeats too (at swipe 5), but card 7 repeats earlier, at swipe 4.

### Example 2

\`\`\`
Input:
3
5 6 8

Output:
-1
\`\`\`

Every card is swiped once.`,
  constraints: ["1 ≤ n ≤ 2·10⁵", "1 ≤ c[i] ≤ 10⁹"],
  timeLimitMs: 1000,
  memoryLimitKb: 262_144,
  ioMode: "STDIN",
  signature: null,
  compareMode: "TOKEN",
  scoringMode: "ICPC",
  stopOnFirstFailure: true,
  checkerSource: null,
  subtasks: [],
  generateTests: secondSwipeTests,
  starters: STDIN_STARTERS,
  references: [
    {
      language: "cpp20",
      label: "Model solution (hash set)",
      expected: "AC",
      source: `#include <bits/stdc++.h>
using namespace std;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);
    int n;
    if (!(cin >> n)) return 0;
    unordered_set<long long> seen;
    seen.reserve(2 * (size_t)n);
    for (int i = 1; i <= n; ++i) {
        long long card;
        cin >> card;
        if (!seen.insert(card).second) {
            cout << card << ' ' << i << '\\n';
            return 0;
        }
    }
    cout << -1 << '\\n';
    return 0;
}
`,
    },
    {
      language: "py312",
      label: "Model solution (hash set)",
      expected: "AC",
      source: `import sys


def main():
    data = sys.stdin.buffer.read().split()
    n = int(data[0])
    seen = set()
    for i in range(1, n + 1):
        card = int(data[i])
        if card in seen:
            print(card, i)
            return
        seen.add(card)
    print(-1)


main()
`,
    },
    {
      language: "cpp20",
      label: "Deliberately wrong: the repeated card seen first",
      expected: "WA",
      source: `#include <bits/stdc++.h>
using namespace std;

// Counts every card, then reports the earliest-seen card that appears twice
// (with the position of its second swipe) - not the first swipe that repeats.
int main() {
    int n;
    if (scanf("%d", &n) != 1) return 0;
    vector<long long> c(n);
    unordered_map<long long, int> count;
    for (auto& x : c) {
        scanf("%lld", &x);
        ++count[x];
    }
    for (int i = 0; i < n; ++i) {
        if (count[c[i]] < 2) continue;
        for (int j = i + 1; j < n; ++j) {
            if (c[j] == c[i]) {
                printf("%lld %d\\n", c[i], j + 1);
                return 0;
            }
        }
    }
    printf("-1\\n");
    return 0;
}
`,
    },
  ],
  help: {
    hints: [
      `Go through the swipes in order. At swipe \`i\`, what do you need to know to decide whether it repeats a card? Only one thing: has this card number already appeared among swipes \`1 … i−1\`?`,
      `Keep the cards you have already seen in a **hash set**. Checking whether a card is in the set and adding it both take O(1) on average, so one pass over the swipes is enough. Searching back through all the earlier swipes instead would take O(n²) — about 2·10¹⁰ steps for the largest tests.`,
      `For \`i\` from 1 to \`n\`: if \`c[i]\` is already in the set, print \`c[i]\` and \`i\` and stop; otherwise add \`c[i]\` to the set. If the loop finishes without stopping, print \`-1\`. Stop at the first **swipe** that repeats — not at the repeated card that was seen earliest (in Example 1 that would wrongly give card 41).`,
    ],
    editorial: `### Approach

Read the swipes in order and remember every card you have already seen. The first time you meet a card that is already remembered, that swipe is the answer — print the card and the swipe's position, and stop. If you reach the end without that happening, print \`-1\`.

"Remember every card" should be a **hash set**: \`unordered_set\` in C++, \`set\` in Python. Looking a card up and adding it take O(1) on average. Scanning back through all the earlier swipes for every new one would also be correct, but costs O(n²) — around 2·10¹⁰ comparisons when \`n = 2·10⁵\` and no card repeats.

**The trap.** It is tempting to first count how often each card appears and then report "the first card in the list that appears twice". That answers a different question. In \`41 7 19 7 41 3\` the first card that appears twice is 41, but the first swipe that *repeats* a card is swipe 4 (card 7) — 41 only repeats at swipe 5. A single left-to-right pass with a set gets this right automatically, because it stops at the earliest moment a repeat happens.

### Complexity

- Time: O(n) on average.
- Memory: O(n) for the set.

### C++

\`\`\`cpp
#include <bits/stdc++.h>
using namespace std;

int main() {
    int n;
    cin >> n;
    unordered_set<long long> seen;
    for (int i = 1; i <= n; ++i) {
        long long card;
        cin >> card;
        if (seen.count(card)) {          // this swipe repeats a card
            cout << card << ' ' << i << '\\n';
            return 0;
        }
        seen.insert(card);
    }
    cout << -1 << '\\n';
}
\`\`\`

### Python

\`\`\`python
import sys

def main():
    data = sys.stdin.buffer.read().split()
    n = int(data[0])
    seen = set()
    for i in range(1, n + 1):
        card = int(data[i])
        if card in seen:                 # this swipe repeats a card
            print(card, i)
            return
        seen.add(card)
    print(-1)

main()
\`\`\`
`,
  },
};
