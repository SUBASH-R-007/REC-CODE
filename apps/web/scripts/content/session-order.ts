/**
 * session-order (REC-0010): FUNCTION mode, MEDIUM, CUSTOM_CHECKER. Originally
 * authored for REC Code: schedule the coding club's workshop sessions so every
 * session comes after the sessions it builds on. Any valid order is accepted,
 * judged by a testlib checker.
 */
import { parseType, serializeArgs, serializeValue, starterStub, type FunctionSignature } from "@recx/shared/harness";
import { functionChecker } from "./checker-json";
import { prng, randomInt, type AuthoredProblem, type AuthoredTest } from "./types";

export const SESSION_ORDER_SIGNATURE: FunctionSignature = {
  className: "Solution",
  methodName: "orderSessions",
  params: [
    { name: "n", type: "int" },
    { name: "prerequisites", type: "matrix<int>" },
  ],
  returns: "list<int>",
  comparator: "CUSTOM_CHECKER",
  mutatedParam: null,
};

export const SESSION_ORDER_LIMITS = Object.freeze({
  maxN: 100_000,
  maxPairs: 200_000,
});

type Pair = [before: number, after: number];

/** The jury's order: Kahn's algorithm with a first-in, first-out queue seeded in index order. */
export function sessionOrder(n: number, prerequisites: readonly Pair[]): number[] {
  const next: number[][] = Array.from({ length: n }, () => []);
  const waitingFor = new Array<number>(n).fill(0);
  for (const [a, b] of prerequisites) {
    next[a]!.push(b);
    waitingFor[b]! += 1;
  }
  const order: number[] = [];
  for (let s = 0; s < n; s++) if (waitingFor[s] === 0) order.push(s);
  for (let head = 0; head < order.length; head++) {
    for (const b of next[order[head]!]!) {
      waitingFor[b]! -= 1;
      if (waitingFor[b] === 0) order.push(b);
    }
  }
  if (order.length !== n) throw new Error("session-order: the prerequisites contain a cycle");
  return order;
}

/** The checker's rule: every session exactly once, and a before b for every pair [a, b]. */
export function isValidSessionOrder(n: number, prerequisites: readonly Pair[], order: readonly number[]): boolean {
  if (order.length !== n) return false;
  const slot = new Array<number>(n).fill(-1);
  for (const [i, s] of order.entries()) {
    if (!Number.isInteger(s) || s < 0 || s >= n || slot[s] !== -1) return false;
    slot[s] = i;
  }
  return prerequisites.every(([a, b]) => slot[a]! < slot[b]!);
}

function shuffled(n: number, r: () => number): number[] {
  const p = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = randomInt(r, 0, i);
    [p[i], p[j]] = [p[j]!, p[i]!];
  }
  return p;
}

/**
 * `count` distinct pairs that all agree with one hidden random order of the
 * sessions, so no cycle is possible. `pick` chooses two positions x < y in
 * that hidden order.
 */
function hiddenOrderPairs(
  n: number,
  count: number,
  seed: number,
  pick: (r: () => number) => [number, number] = (r) => {
    const x = randomInt(r, 0, n - 1);
    let y = randomInt(r, 0, n - 2);
    if (y >= x) y += 1;
    return x < y ? [x, y] : [y, x];
  },
): Pair[] {
  const r = prng(seed);
  const hidden = shuffled(n, r);
  const seen = new Set<number>();
  const pairs: Pair[] = [];
  while (pairs.length < count) {
    const [x, y] = pick(r);
    const key = x * n + y;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push([hidden[x]!, hidden[y]!]);
  }
  return pairs;
}

/** Every pair a hidden order allows, in a shuffled list: the densest possible test. */
function completePairs(n: number, seed: number): Pair[] {
  const r = prng(seed);
  const hidden = shuffled(n, r);
  const pairs: Pair[] = [];
  for (let x = 0; x < n; x++) for (let y = x + 1; y < n; y++) pairs.push([hidden[x]!, hidden[y]!]);
  const order = shuffled(pairs.length, r);
  return order.map((i) => pairs[i]!);
}

const TYPES = SESSION_ORDER_SIGNATURE.params.map((p) => parseType(p.type));
const RETURNS = parseType(SESSION_ORDER_SIGNATURE.returns);

function sessionOrderTests(): AuthoredTest[] {
  const { maxN, maxPairs } = SESSION_ORDER_LIMITS;
  const backwardsChain = (n: number): Pair[] => Array.from({ length: n - 1 }, (_, i): Pair => [i + 1, i]);
  const cases: { n: number; prerequisites: Pair[]; isSample: boolean }[] = [
    {
      n: 5,
      prerequisites: [
        [3, 0],
        [0, 4],
        [3, 1],
        [1, 4],
        [2, 4],
      ],
      isSample: true,
    },
    { n: 3, prerequisites: [], isSample: true },
    { n: 1, prerequisites: [], isSample: false },
    { n: 2, prerequisites: [[1, 0]], isSample: false },
    { n: 6, prerequisites: backwardsChain(6), isSample: false },
    { n: 8, prerequisites: completePairs(8, 111), isSample: false },
    { n: 1000, prerequisites: Array.from({ length: 999 }, (_, i): Pair => [0, i + 1]), isSample: false },
    { n: 1000, prerequisites: Array.from({ length: 999 }, (_, i): Pair => [i + 1, 0]), isSample: false },
    { n: 2000, prerequisites: hiddenOrderPairs(2000, 5000, 112), isSample: false },
    // One long chain: a recursive depth-first search goes 10⁵ calls deep.
    { n: maxN, prerequisites: backwardsChain(maxN), isSample: false },
    { n: maxN, prerequisites: hiddenOrderPairs(maxN, maxPairs, 113), isSample: false },
    { n: maxN, prerequisites: [], isSample: false },
    {
      // Short hops in the hidden order: long dependency paths, many small clusters.
      n: maxN,
      prerequisites: hiddenOrderPairs(maxN, 150_000, 114, (r) => {
        const x = randomInt(r, 0, maxN - 6);
        return [x, x + randomInt(r, 1, 5)];
      }),
      isSample: false,
    },
    {
      // 100 layers of 1000 sessions; every pair links one layer to the next.
      n: maxN,
      prerequisites: hiddenOrderPairs(maxN, maxPairs, 115, (r) => {
        const layer = randomInt(r, 0, 98);
        return [layer * 1000 + randomInt(r, 0, 999), (layer + 1) * 1000 + randomInt(r, 0, 999)];
      }),
      isSample: false,
    },
  ];
  return cases.map(({ n, prerequisites, isSample }) => ({
    isSample,
    subtask: null,
    input: serializeArgs(TYPES, [n, prerequisites]),
    output: serializeValue(RETURNS, sessionOrder(n, prerequisites)) + "\n",
  }));
}

const SESSION_ORDER_CHECKER = functionChecker(
  String.raw`// session-order: accept ANY order of the sessions 0..n-1 that runs session a
// before session b for every pair [a, b] in prerequisites.
//   input.txt   line 1: n, line 2: prerequisites
//   answer.txt  the jury's order (checked as well: a bad one is FAIL, not WA)
//   output.txt  the contestant's order`,
  String.raw`void checkOrder(const std::vector<long long>& order, int n,
                const std::vector<std::pair<int, int>>& before, TResult verdict, const char* who) {
    if ((long long)order.size() != n) {
        quitf(verdict, "%s lists %d sessions, but there are %d", who, (int)order.size(), n);
    }
    std::vector<int> slot(n, -1);
    for (int i = 0; i < n; ++i) {
        long long s = order[i];
        if (s < 0 || s >= n) quitf(verdict, "%s: there is no session %lld (sessions are 0..%d)", who, s, n - 1);
        if (slot[s] != -1) quitf(verdict, "%s lists session %lld twice", who, s);
        slot[s] = i;
    }
    for (const auto& [a, b] : before) {
        if (slot[a] > slot[b]) {
            quitf(verdict, "%s runs session %d before session %d, but the pair [%d, %d] needs %d first", who, b, a, a, b, a);
        }
    }
}

int main(int argc, char* argv[]) {
    registerTestlibCmd(argc, argv);

    JsonLine nLine(inf.readLine(), _fail, "input n");
    int n = (int)nLine.integer(1, 100000);
    nLine.end();
    JsonLine pairsLine(inf.readLine(), _fail, "input prerequisites");
    std::vector<std::pair<int, int>> before;
    for (const auto& pair : pairsLine.matrix(0, n - 1)) {
        if (pair.size() != 2) quitf(_fail, "input prerequisites: a pair has %d values", (int)pair.size());
        before.emplace_back((int)pair[0], (int)pair[1]);
    }
    pairsLine.end();

    JsonLine juryLine(ans.readLine(), _fail, "the jury's answer");
    std::vector<long long> jury = juryLine.list(INT_MIN, INT_MAX);
    juryLine.end();
    checkOrder(jury, n, before, _fail, "the jury's order");

    JsonLine outLine(ouf.readLine(), _wa, "your output");
    std::vector<long long> order = outLine.list(INT_MIN, INT_MAX);
    outLine.end();
    checkOrder(order, n, before, _wa, "your order");

    quitf(_ok, "a valid order of %d sessions", n);
}`,
);

export const SESSION_ORDER: AuthoredProblem = {
  slug: "session-order",
  displayCode: "REC-0010",
  title: "Workshop Session Order",
  difficulty: "MEDIUM",
  topics: ["GRAPHS"],
  statement: `The coding club is planning a workshop series with \`n\` sessions, numbered \`0\` to \`n - 1\`. Some sessions build on others: a pair \`[a, b]\` in \`prerequisites\` means session \`a\` must take place **before** session \`b\`.

Write \`orderSessions(n, prerequisites)\` that returns an order for the whole series: a list containing every session number from \`0\` to \`n - 1\` exactly once, in which \`a\` comes before \`b\` for every pair \`[a, b]\`.

The pairs never contradict each other (no session ends up needing itself), so such an order always exists. When several orders work, return **any** of them: the judge checks your order against the pairs instead of comparing it with one fixed answer.

### Example 1

\`\`\`
Input:  n = 5, prerequisites = [[3, 0], [0, 4], [3, 1], [1, 4], [2, 4]]
Output: [2, 3, 0, 1, 4]
\`\`\`

Session 3 must come before sessions 0 and 1, and session 4 needs sessions 0, 1 and 2 first. \`[3, 2, 0, 1, 4]\` and \`[3, 0, 1, 2, 4]\` are also accepted; \`[0, 1, 2, 3, 4]\` is not, because it runs session 0 before session 3.

### Example 2

\`\`\`
Input:  n = 3, prerequisites = []
Output: [0, 1, 2]
\`\`\`

No session depends on another, so every order of \`0\`, \`1\` and \`2\` is accepted.`,
  constraints: [
    "1 ≤ n ≤ 10⁵",
    "0 ≤ prerequisites.length ≤ 2·10⁵",
    "prerequisites[i] = [a, b] with 0 ≤ a, b < n and a ≠ b",
    "No pair appears twice, and the pairs never form a cycle.",
  ],
  timeLimitMs: 1000,
  memoryLimitKb: 262_144,
  ioMode: "FUNCTION",
  signature: SESSION_ORDER_SIGNATURE,
  compareMode: "CHECKER",
  scoringMode: "ICPC",
  stopOnFirstFailure: true,
  checkerSource: SESSION_ORDER_CHECKER,
  subtasks: [],
  generateTests: sessionOrderTests,
  starters: {
    cpp20: starterStub("cpp20", SESSION_ORDER_SIGNATURE),
    py312: starterStub("py312", SESSION_ORDER_SIGNATURE),
  },
  references: [
    {
      language: "cpp20",
      label: "Model solution (Kahn's algorithm)",
      expected: "AC",
      source: `class Solution {
public:
    vector<int> orderSessions(int n, vector<vector<int>>& prerequisites) {
        vector<vector<int>> next(n);
        vector<int> waitingFor(n, 0);
        for (auto& p : prerequisites) {
            next[p[0]].push_back(p[1]);
            ++waitingFor[p[1]];
        }
        vector<int> order;
        order.reserve(n);
        for (int s = 0; s < n; ++s)
            if (waitingFor[s] == 0) order.push_back(s);
        for (size_t head = 0; head < order.size(); ++head)
            for (int b : next[order[head]])
                if (--waitingFor[b] == 0) order.push_back(b);
        return order;
    }
};
`,
    },
    {
      language: "py312",
      label: "Model solution (Kahn's algorithm)",
      expected: "AC",
      source: `class Solution:
    def orderSessions(self, n: int, prerequisites: List[List[int]]) -> List[int]:
        nxt = [[] for _ in range(n)]
        waiting_for = [0] * n
        for a, b in prerequisites:
            nxt[a].append(b)
            waiting_for[b] += 1
        order = [s for s in range(n) if waiting_for[s] == 0]
        head = 0
        while head < len(order):
            for b in nxt[order[head]]:
                waiting_for[b] -= 1
                if waiting_for[b] == 0:
                    order.append(b)
            head += 1
        return order
`,
    },
    {
      language: "java21",
      label: "Model solution (Kahn's algorithm)",
      expected: "AC",
      source: `class Solution {
    public int[] orderSessions(int n, int[][] prerequisites) {
        int m = prerequisites.length;
        // Adjacency lists in compressed form: the sessions after s are
        // next[start[s] .. start[s + 1] - 1].
        int[] start = new int[n + 1];
        int[] waitingFor = new int[n];
        for (int[] p : prerequisites) {
            start[p[0] + 1]++;
            waitingFor[p[1]]++;
        }
        for (int s = 0; s < n; s++) start[s + 1] += start[s];
        int[] fill = Arrays.copyOf(start, n);
        int[] next = new int[m];
        for (int[] p : prerequisites) next[fill[p[0]]++] = p[1];

        int[] order = new int[n];
        int size = 0;
        for (int s = 0; s < n; s++) if (waitingFor[s] == 0) order[size++] = s;
        for (int head = 0; head < size; head++) {
            int a = order[head];
            for (int e = start[a]; e < start[a + 1]; e++) {
                if (--waitingFor[next[e]] == 0) order[size++] = next[e];
            }
        }
        return order;
    }
}
`,
    },
    {
      language: "cpp20",
      label: "Deliberately wrong: index order",
      expected: "WA",
      source: `// Ignores the prerequisites and runs the sessions in number order. That is
// only right when every pair happens to point from a smaller number to a
// larger one.
class Solution {
public:
    vector<int> orderSessions(int n, vector<vector<int>>& prerequisites) {
        vector<int> order(n);
        for (int s = 0; s < n; ++s) order[s] = s;
        return order;
    }
};
`,
    },
  ],
  help: {
    hints: [
      `Picture the sessions as dots and each pair \`[a, b]\` as an arrow from \`a\` to \`b\`. Which sessions are safe to schedule **first**, before you have placed anything else? Is there always at least one?`,
      `A session with no incoming arrow waits for nobody, so it can go next. Once it is scheduled, remove its outgoing arrows — some other sessions may now be waiting for nobody too. Keep a counter per session: how many of its prerequisites are still unscheduled. A session becomes ready when its counter reaches 0.`,
      `Build, for every session \`a\`, the list of sessions \`b\` with a pair \`[a, b]\`, and count \`waiting[b]\` = the number of pairs ending at \`b\`. Put every session with \`waiting == 0\` into a queue. Repeatedly take a session from the queue, append it to the answer, and decrease \`waiting\` of each session after it; whenever a counter reaches 0, add that session to the queue. Because the pairs never form a cycle, all \`n\` sessions get scheduled. This is O(n + number of pairs) and uses no recursion — with a chain of 10⁵ sessions, a recursive depth-first search can overflow the stack, especially in Python.`,
    ],
    editorial: `### Approach

Draw each session as a node and each pair \`[a, b]\` as an arrow \`a → b\`. We need a **topological order** of this directed graph: an order of the nodes in which every arrow points forwards.

**Who can go first?** A session with no incoming arrow waits for nobody. Such a session always exists: if every session had an incoming arrow, we could walk backwards along arrows forever, and since there are only \`n\` sessions we would visit one twice — a cycle, which the statement rules out.

**Kahn's algorithm** repeats that observation:

1. For every session, count \`waiting[s]\`, the number of pairs \`[a, s]\` — prerequisites not yet scheduled — and build the list of sessions that come after it.
2. Put every session with \`waiting[s] == 0\` into a queue.
3. While the queue is not empty: take session \`a\`, append it to the answer, and for every \`b\` after \`a\` decrease \`waiting[b]\`. When \`waiting[b]\` reaches 0, all of \`b\`'s prerequisites are already in the answer, so \`b\` joins the queue.

Every session enters the queue exactly once, after all of its prerequisites have been appended, so every pair \`[a, b]\` has \`a\` before \`b\` in the answer.

Many different orders can be correct, and the checker accepts any of them. Using a queue, a stack or a min-heap for the ready sessions gives different, equally valid answers.

**Why not recursion?** A depth-first search that appends a session after finishing its descendants also works (reverse the result at the end), but a chain of 10⁵ sessions makes the recursion 10⁵ calls deep. That overflows Python's default recursion limit, so the iterative queue is the safer choice.

### Complexity

- Time: O(n + p), where p is the number of pairs — every session and every pair is handled once.
- Memory: O(n + p) for the lists of sessions after each session.

### C++

\`\`\`cpp
class Solution {
public:
    vector<int> orderSessions(int n, vector<vector<int>>& prerequisites) {
        vector<vector<int>> after(n);
        vector<int> waiting(n, 0);
        for (auto& p : prerequisites) { after[p[0]].push_back(p[1]); ++waiting[p[1]]; }

        vector<int> order;                                  // doubles as the queue
        for (int s = 0; s < n; ++s) if (waiting[s] == 0) order.push_back(s);
        for (size_t head = 0; head < order.size(); ++head)
            for (int b : after[order[head]])
                if (--waiting[b] == 0) order.push_back(b);
        return order;
    }
};
\`\`\`

### Python

\`\`\`python
class Solution:
    def orderSessions(self, n: int, prerequisites: List[List[int]]) -> List[int]:
        after = [[] for _ in range(n)]
        waiting = [0] * n
        for a, b in prerequisites:
            after[a].append(b)
            waiting[b] += 1

        ready = deque(s for s in range(n) if waiting[s] == 0)
        order = []
        while ready:
            a = ready.popleft()
            order.append(a)
            for b in after[a]:
                waiting[b] -= 1
                if waiting[b] == 0:
                    ready.append(b)
        return order
\`\`\`
`,
  },
};
