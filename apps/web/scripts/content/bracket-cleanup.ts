/**
 * bracket-cleanup (REC-0002): CHECKER compare mode — any minimum set of
 * deletions is accepted, judged by a testlib checker. Originally authored for
 * REC Code (Phase 2); hints and editorial added in Phase 3.
 *
 * The tests are byte-identical to the ones the Phase 2 seed wrote, so a fresh
 * database gets exactly the data that was validated on the judge.
 */
import { prng, STDIN_STARTERS, type AuthoredProblem, type AuthoredTest } from "./types";

/** Positions (1-based) the reference algorithm deletes: unmatched ')' then the '(' left open. */
export function bracketDeletions(line: string): number[] {
  const open: number[] = [];
  const removed: number[] = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "(") open.push(i + 1);
    else if (open.length > 0) open.pop();
    else removed.push(i + 1);
  }
  return [...removed, ...open];
}

function randomBrackets(n: number, openProbability: number, seed: number): string {
  const r = prng(seed);
  let s = "";
  for (let i = 0; i < n; i++) s += r() < openProbability ? "(" : ")";
  return s;
}

/** A random balanced line of even length n. */
function balancedBrackets(n: number, seed: number): string {
  const r = prng(seed);
  const out: string[] = [];
  let depth = 0;
  for (let i = 0; i < n; i++) {
    const remaining = n - i;
    const open = depth === 0 ? true : remaining === depth ? false : r() < 0.5;
    out.push(open ? "(" : ")");
    depth += open ? 1 : -1;
  }
  return out.join("");
}

function bracketTests(): AuthoredTest[] {
  const lines: { line: string; isSample: boolean }[] = [
    { line: "(()))(", isSample: true },
    { line: "()()", isSample: true },
    { line: ")", isSample: false },
    { line: "(", isSample: false },
    { line: "((((()))", isSample: false },
    { line: "(".repeat(1000), isSample: false },
    { line: ")".repeat(2000), isSample: false },
    { line: ")(".repeat(100_000), isSample: false },
    { line: "(".repeat(100_000) + ")".repeat(99_999), isSample: false },
    { line: balancedBrackets(200_000, 101), isSample: false },
    { line: randomBrackets(200_000, 0.5, 202), isSample: false },
    { line: randomBrackets(200_000, 0.6, 303), isSample: false },
    { line: randomBrackets(200_000, 0.4, 404), isSample: false },
  ];
  return lines.map(({ line, isSample }) => {
    const removed = bracketDeletions(line);
    return {
      isSample,
      subtask: null,
      input: `${line.length}\n${line}\n`,
      output: `${removed.length}\n${removed.join(" ")}\n`,
    };
  });
}

const BRACKET_CHECKER = `#include "testlib.h"
#include <string>
#include <vector>

// bracket-cleanup: accept any set of deletions of minimum size that leaves a
// balanced line. inf = the test input, ouf = the contestant, ans = the jury.
int main(int argc, char* argv[]) {
    registerTestlibCmd(argc, argv);
    int n = inf.readInt();
    std::string line = inf.readToken();
    int best = ans.readInt();

    int k = ouf.readInt(0, n, "k");
    std::vector<char> deleted(n + 1, 0);
    for (int i = 0; i < k; ++i) {
        int p = ouf.readInt(1, n, "position");
        if (deleted[p]) quitf(_wa, "position %d is deleted twice", p);
        deleted[p] = 1;
    }

    int depth = 0;
    for (int i = 1; i <= n; ++i) {
        if (deleted[i]) continue;
        depth += line[i - 1] == '(' ? 1 : -1;
        if (depth < 0) quitf(_wa, "after the deletions, the ')' at position %d has no matching '('", i);
    }
    if (depth != 0) quitf(_wa, "after the deletions, %d '(' remain unmatched", depth);
    if (k > best) quitf(_wa, "%d deletions, but %d are enough", k, best);
    if (k < best) quitf(_fail, "the contestant needed only %d deletions, the jury %d", k, best);
    quitf(_ok, "%d deletions", k);
}
`;

export const BRACKET_CLEANUP: AuthoredProblem = {
  slug: "bracket-cleanup",
  displayCode: "REC-0002",
  title: "Bracket Cleanup",
  difficulty: "EASY",
  topics: ["STACK_QUEUE", "STRINGS", "GREEDY"],
  statement: `The lab's code formatter crashed halfway through a file and left behind one long line made only of round brackets \`(\` and \`)\`.

You may **delete** characters from the line. Delete as **few** characters as possible so that what remains is a balanced bracket sequence, and report which positions you deleted.

A line is *balanced* when its brackets can be split into pairs, each pair an \`(\` followed somewhere later by a \`)\`, with pairs either nested or side by side, never crossing. The empty line is balanced.

### Input

The first line contains an integer \`n\`, the length of the line. The second line contains the \`n\` brackets, with no spaces.

### Output

On the first line print \`k\`, the smallest number of characters to delete. On the second line print the \`k\` positions you delete (1-based, distinct, in any order). When \`k = 0\` the second line may be empty.

**Any** correct answer is accepted: when several sets of \`k\` positions work, print any one of them.

### Example 1

\`\`\`
Input:
6
(()))(

Output:
2
5 6
\`\`\`

Deleting positions 5 and 6 leaves \`(())\`. Deleting positions 4 and 6 leaves \`(())\` as well, so \`2\` / \`4 6\` is also accepted.

### Example 2

\`\`\`
Input:
4
()()

Output:
0
\`\`\`

The line is already balanced.`,
  constraints: ["1 ≤ n ≤ 2·10⁵", "The line contains only ( and )."],
  timeLimitMs: 1000,
  memoryLimitKb: 262_144,
  ioMode: "STDIN",
  signature: null,
  compareMode: "CHECKER",
  scoringMode: "ICPC",
  stopOnFirstFailure: true,
  checkerSource: BRACKET_CHECKER,
  subtasks: [],
  generateTests: bracketTests,
  starters: STDIN_STARTERS,
  references: [
    {
      language: "cpp20",
      label: "Model solution (stack)",
      expected: "AC",
      source: `#include <bits/stdc++.h>
using namespace std;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);
    int n;
    string line;
    if (!(cin >> n >> line)) return 0;
    vector<int> open, removed;
    open.reserve(n);
    for (int i = 0; i < (int)line.size(); ++i) {
        if (line[i] == '(') open.push_back(i + 1);
        else if (!open.empty()) open.pop_back();
        else removed.push_back(i + 1);
    }
    removed.insert(removed.end(), open.begin(), open.end());
    string out = to_string(removed.size()) + "\\n";
    for (size_t i = 0; i < removed.size(); ++i) {
        if (i) out += ' ';
        out += to_string(removed[i]);
    }
    out += '\\n';
    fwrite(out.data(), 1, out.size(), stdout);
    return 0;
}
`,
    },
    {
      language: "py312",
      label: "Model solution (stack)",
      expected: "AC",
      source: `import sys


def main():
    data = sys.stdin.buffer.read().split()
    line = data[1].decode() if len(data) > 1 else ""
    open_at = []
    removed = []
    for i, ch in enumerate(line, 1):
        if ch == "(":
            open_at.append(i)
        elif open_at:
            open_at.pop()
        else:
            removed.append(i)
    removed.extend(open_at)
    sys.stdout.write(f"{len(removed)}\\n{' '.join(map(str, removed))}\\n")


main()
`,
    },
    {
      language: "cpp20",
      label: "Deliberately wrong: forgets the ( left open",
      expected: "WA",
      source: `#include <bits/stdc++.h>
using namespace std;

// Deletes every ')' that has no partner, but never the '(' still open at the end.
int main() {
    int n;
    string line;
    if (!(cin >> n >> line)) return 0;
    int depth = 0;
    vector<int> removed;
    for (int i = 0; i < (int)line.size(); ++i) {
        if (line[i] == '(') ++depth;
        else if (depth > 0) --depth;
        else removed.push_back(i + 1);
    }
    printf("%d\\n", (int)removed.size());
    for (size_t i = 0; i < removed.size(); ++i) printf(i ? " %d" : "%d", removed[i]);
    printf("\\n");
    return 0;
}
`,
    },
  ],
  help: {
    hints: [
      `Read the line from left to right and keep count of the \`(\` that are still waiting for a partner. Ask yourself: when can a \`)\` *never* be matched, whatever else you keep or delete?`,
      `A \`)\` that arrives while no \`(\` is waiting has no possible partner on its left, so it has to go. Every other \`)\` can close the most recent waiting \`(\`. When the scan ends, the \`(\` still waiting have no partner on their right, so they have to go too. Both kinds of deletion are forced — that is why deleting exactly these is the minimum.`,
      `Use a stack of positions. For \`(\` at position \`i\`, push \`i\`. For \`)\` at position \`i\`, pop if the stack is not empty, otherwise record \`i\` as deleted. At the end, every position left on the stack is deleted as well. Print how many you deleted, then the positions (1-based). With 2·10⁵ characters, build the output in one string instead of printing number by number.`,
    ],
    editorial: `### Approach

Scan the line once, from left to right, keeping a stack of the positions of \`(\` that have not been matched yet.

- On \`(\`: push its position.
- On \`)\`: if the stack is not empty, this \`)\` closes the \`(\` on top — pop it. If the stack is empty, nothing to the left can ever match this \`)\`, so it **must** be deleted: record its position.

When the scan ends, every \`(\` still on the stack has no \`)\` to its right that is free to match it, so each of those **must** be deleted too.

**Why this is the minimum.** Say the scan finds \`u\` unmatched \`)\` and leaves \`v\` unmatched \`(\`. The part of the line up to the last unmatched \`)\` contains exactly \`u\` more \`)\` than \`(\`; a balanced line never has more \`)\` than \`(\` in any prefix, so at least \`u\` characters of that part must go. The rest of the line contains exactly \`v\` more \`(\` than \`)\`, so at least \`v\` characters of it must go. That is at least \`u + v\` deletions — and deleting exactly the recorded positions leaves a balanced line, because every remaining bracket was paired during the scan.

The checker accepts **any** minimum answer — for \`(()))(\`, both \`5 6\` and \`4 6\` are fine — so you do not have to reproduce the jury's exact positions.

### Complexity

- Time: O(n) — every position is pushed and popped at most once.
- Memory: O(n) for the stack and the list of deletions.

### C++

\`\`\`cpp
#include <bits/stdc++.h>
using namespace std;

int main() {
    int n;
    string line;
    cin >> n >> line;
    vector<int> waiting, deleted;          // positions are 1-based
    for (int i = 0; i < n; ++i) {
        if (line[i] == '(') waiting.push_back(i + 1);
        else if (!waiting.empty()) waiting.pop_back();
        else deleted.push_back(i + 1);       // a ')' with no partner
    }
    deleted.insert(deleted.end(), waiting.begin(), waiting.end());
    string out = to_string(deleted.size()) + "\\n";
    for (size_t k = 0; k < deleted.size(); ++k) {
        if (k) out += ' ';
        out += to_string(deleted[k]);
    }
    cout << out << '\\n';
}
\`\`\`

### Python

\`\`\`python
import sys

def main():
    data = sys.stdin.read().split()
    line = data[1]
    waiting, deleted = [], []
    for i, ch in enumerate(line, 1):
        if ch == "(":
            waiting.append(i)
        elif waiting:
            waiting.pop()
        else:
            deleted.append(i)              # a ')' with no partner
    deleted.extend(waiting)               # '(' that were never closed
    print(len(deleted))
    print(" ".join(map(str, deleted)))

main()
\`\`\`
`,
  },
};
