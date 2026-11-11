/**
 * bench-blackout (REC-0009): FUNCTION mode, MEDIUM, IN_PLACE_MUTATION on a
 * matrix. Originally authored for REC Code: close every row and column of
 * the exam lab that holds a faulty computer, marking the closed seats in
 * place.
 */
import { parseType, serializeArgs, serializeValue, starterStub, type FunctionSignature } from "@recx/shared/harness";
import { prng, randomInt, type AuthoredProblem, type AuthoredTest } from "./types";

export const BENCH_BLACKOUT_SIGNATURE: FunctionSignature = {
  className: "Solution",
  methodName: "closeBenches",
  params: [{ name: "grid", type: "matrix<int>" }],
  returns: "void",
  comparator: "IN_PLACE_MUTATION",
  mutatedParam: "grid",
};

export const BENCH_BLACKOUT_LIMITS = Object.freeze({
  maxSide: 400,
  maxTag: 1_000_000_000,
});

/** The reference rule: a seat is closed when its row or its column held a 0 at the start. */
export function closedGrid(grid: readonly (readonly number[])[]): number[][] {
  const rows = grid.map((row) => row.includes(0));
  const cols = grid[0]!.map((_, c) => grid.some((row) => row[c] === 0));
  return grid.map((row, r) => row.map((v, c) => (rows[r] || cols[c] ? 0 : v)));
}

/** An m × n grid of asset tags in [1, maxTag]; each seat is faulty (0) with probability `faulty`. */
function randomGrid(m: number, n: number, faulty: number, seed: number): number[][] {
  const r = prng(seed);
  return Array.from({ length: m }, () =>
    Array.from({ length: n }, () => (r() < faulty ? 0 : randomInt(r, 1, BENCH_BLACKOUT_LIMITS.maxTag))),
  );
}

/** A grid with no faulty seat except the listed ones. */
function withFaults(m: number, n: number, faults: readonly [number, number][], seed: number): number[][] {
  const grid = randomGrid(m, n, 0, seed);
  for (const [r, c] of faults) grid[r]![c] = 0;
  return grid;
}

const GRID = parseType(BENCH_BLACKOUT_SIGNATURE.params[0]!.type);

function benchBlackoutTests(): AuthoredTest[] {
  const { maxSide } = BENCH_BLACKOUT_LIMITS;
  const cases: { grid: number[][]; isSample: boolean }[] = [
    {
      grid: [
        [5, 8, 2],
        [4, 0, 7],
        [9, 3, 6],
      ],
      isSample: true,
    },
    {
      grid: [
        [6, 0, 3, 8],
        [2, 7, 1, 5],
        [0, 4, 9, 6],
      ],
      isSample: true,
    },
    { grid: [[0]], isSample: false },
    { grid: [[7]], isSample: false },
    { grid: [[1, 2, 0, 4, 5]], isSample: false },
    { grid: [[3], [0], [8]], isSample: false },
    { grid: randomGrid(3, 4, 0, 91), isSample: false },
    { grid: randomGrid(2, 3, 1, 92), isSample: false },
    // The top-left corner alone: the classic trap for the first-row/first-column marker trick.
    { grid: withFaults(4, 5, [[0, 0]], 93), isSample: false },
    { grid: withFaults(5, 6, [[0, 3], [2, 0]], 94), isSample: false },
    { grid: randomGrid(50, 70, 0.03, 95), isSample: false },
    { grid: withFaults(maxSide, maxSide, [[17, 301], [17, 302], [250, 0], [399, 123]], 96), isSample: false },
    { grid: randomGrid(maxSide, maxSide, 0, 97), isSample: false },
    { grid: randomGrid(maxSide, maxSide, 0.3, 98), isSample: false },
    { grid: withFaults(maxSide, 1, [[200, 0]], 99), isSample: false },
    { grid: withFaults(1, maxSide, [[0, 399]], 100), isSample: false },
    { grid: withFaults(maxSide, maxSide, [[maxSide - 1, maxSide - 1]], 101), isSample: false },
  ];
  return cases.map(({ grid, isSample }) => ({
    isSample,
    subtask: null,
    input: serializeArgs([GRID], [grid]),
    output: serializeValue(GRID, closedGrid(grid)) + "\n",
  }));
}

export const BENCH_BLACKOUT: AuthoredProblem = {
  slug: "bench-blackout",
  displayCode: "REC-0009",
  title: "Bench Blackout",
  difficulty: "MEDIUM",
  topics: ["ARRAYS_HASHING"],
  statement: `The exam lab is a grid of computers with \`m\` rows and \`n\` columns. \`grid[r][c]\` is the asset tag of the computer in row \`r\`, column \`c\` — or \`0\` when that computer failed the morning check.

Before the exam starts, the invigilator **closes** every row that contains a failed computer and every column that contains a failed computer, so nobody sits next to a machine that is being repaired. Every seat in a closed row or a closed column is marked \`0\`.

Only the computers that failed the morning check cause closures: a seat that becomes \`0\` because it was closed does **not** close its own row and column.

Write \`closeBenches(grid)\` that marks the closed seats **in place**. The function returns nothing: after it returns, the judge prints \`grid\`.

### Example 1

\`\`\`
Input:  grid = [[5, 8, 2], [4, 0, 7], [9, 3, 6]]
Output: [[5, 0, 2], [0, 0, 0], [9, 0, 6]]
\`\`\`

The failed computer in row 1, column 1 closes row 1 and column 1. The four corner seats stay open.

### Example 2

\`\`\`
Input:  grid = [[6, 0, 3, 8], [2, 7, 1, 5], [0, 4, 9, 6]]
Output: [[0, 0, 0, 0], [0, 0, 1, 5], [0, 0, 0, 0]]
\`\`\`

Rows 0 and 2 and columns 0 and 1 are closed. In row 1, only the seats in columns 2 and 3 stay open.

### Follow-up

Remembering the closed rows and columns in two extra arrays takes O(m + n) memory. Can you do it with O(1) extra memory?`,
  constraints: ["1 ≤ m, n ≤ 400", "0 ≤ grid[r][c] ≤ 10⁹", "Every row of grid has n values."],
  timeLimitMs: 1000,
  memoryLimitKb: 262_144,
  ioMode: "FUNCTION",
  signature: BENCH_BLACKOUT_SIGNATURE,
  compareMode: "TOKEN",
  scoringMode: "ICPC",
  stopOnFirstFailure: true,
  checkerSource: null,
  subtasks: [],
  generateTests: benchBlackoutTests,
  starters: {
    cpp20: starterStub("cpp20", BENCH_BLACKOUT_SIGNATURE),
    py312: starterStub("py312", BENCH_BLACKOUT_SIGNATURE),
  },
  references: [
    {
      language: "cpp20",
      label: "Model solution (mark first, close second)",
      expected: "AC",
      source: `class Solution {
public:
    void closeBenches(vector<vector<int>>& grid) {
        int m = grid.size(), n = grid[0].size();
        vector<char> rowClosed(m, 0), colClosed(n, 0);
        for (int r = 0; r < m; ++r)
            for (int c = 0; c < n; ++c)
                if (grid[r][c] == 0) rowClosed[r] = colClosed[c] = 1;
        for (int r = 0; r < m; ++r)
            for (int c = 0; c < n; ++c)
                if (rowClosed[r] || colClosed[c]) grid[r][c] = 0;
    }
};
`,
    },
    {
      language: "py312",
      label: "Model solution (mark first, close second)",
      expected: "AC",
      source: `class Solution:
    def closeBenches(self, grid: List[List[int]]) -> None:
        n = len(grid[0])
        closed_rows = [0 in row for row in grid]
        closed_cols = [False] * n
        for row in grid:
            for c, tag in enumerate(row):
                if tag == 0:
                    closed_cols[c] = True
        for r, row in enumerate(grid):
            if closed_rows[r]:
                row[:] = [0] * n
            else:
                for c in range(n):
                    if closed_cols[c]:
                        row[c] = 0
`,
    },
    {
      language: "java21",
      label: "Model solution (O(1) memory: first row and column as markers)",
      expected: "AC",
      source: `class Solution {
    public void closeBenches(int[][] grid) {
        int m = grid.length, n = grid[0].length;
        boolean firstRowClosed = false, firstColClosed = false;
        for (int c = 0; c < n; c++) if (grid[0][c] == 0) firstRowClosed = true;
        for (int r = 0; r < m; r++) if (grid[r][0] == 0) firstColClosed = true;
        // Record every other closure in row 0 and column 0.
        for (int r = 1; r < m; r++) {
            for (int c = 1; c < n; c++) {
                if (grid[r][c] == 0) {
                    grid[r][0] = 0;
                    grid[0][c] = 0;
                }
            }
        }
        for (int r = 1; r < m; r++) {
            for (int c = 1; c < n; c++) {
                if (grid[r][0] == 0 || grid[0][c] == 0) grid[r][c] = 0;
            }
        }
        if (firstRowClosed) for (int c = 0; c < n; c++) grid[0][c] = 0;
        if (firstColClosed) for (int r = 0; r < m; r++) grid[r][0] = 0;
    }
}
`,
    },
    {
      language: "cpp20",
      label: "Deliberately wrong: closes while scanning, so closures cascade",
      expected: "WA",
      source: `// Closes a row and a column the moment it meets a 0. Seats it has just set to
// 0 are met again later in the scan and close their own rows and columns too.
class Solution {
public:
    void closeBenches(vector<vector<int>>& grid) {
        int m = grid.size(), n = grid[0].size();
        for (int r = 0; r < m; ++r) {
            for (int c = 0; c < n; ++c) {
                if (grid[r][c] != 0) continue;
                for (int k = 0; k < n; ++k) grid[r][k] = 0;
                for (int k = 0; k < m; ++k) grid[k][c] = 0;
            }
        }
    }
};
`,
    },
  ],
  help: {
    hints: [
      `Try closing a row and a column the moment you find a \`0\`, and run that on Example 1 by hand. The seats you just set to \`0\` look exactly like failed computers when the scan reaches them. How can you tell the two kinds of \`0\` apart?`,
      `Separate **finding** from **closing**. First scan the whole grid and only record which rows and which columns contain a failed computer — for example in two boolean arrays \`rowClosed[m]\` and \`colClosed[n]\`. Then make a second pass and set \`grid[r][c] = 0\` whenever \`rowClosed[r]\` or \`colClosed[c]\` is true. The first pass never writes, so nothing cascades.`,
      `For O(1) extra memory, keep the markers inside the grid itself: row 0 marks closed columns and column 0 marks closed rows. Before you overwrite them, save two booleans: does row 0 contain a \`0\`, and does column 0 contain a \`0\`? Then, for every seat with \`r ≥ 1\` and \`c ≥ 1\` that holds \`0\`, set \`grid[r][0] = 0\` and \`grid[0][c] = 0\`. Next, for every \`r ≥ 1\`, \`c ≥ 1\`: close the seat if \`grid[r][0] == 0\` or \`grid[0][c] == 0\`. Close row 0 and column 0 **last**, using the two saved booleans — closing them earlier would wipe out the markers.`,
    ],
    editorial: `### Approach

The tempting one-pass idea — "when I see a \`0\`, close its row and column right away" — is wrong. The seats it closes become \`0\` too, and when the scan reaches them they look exactly like failed computers, so closures spread until most of the lab is shut. In Example 1, closing row 1 and column 1 makes \`grid[1][2]\` zero, which then closes column 2, and so on.

The fix is to **separate finding from closing**:

1. Scan the grid once without writing anything. Record \`rowClosed[r] = true\` when row \`r\` has a \`0\`, and \`colClosed[c] = true\` when column \`c\` has a \`0\`.
2. Scan again and set \`grid[r][c] = 0\` whenever \`rowClosed[r]\` or \`colClosed[c]\`.

That needs O(m + n) extra memory for the two marker arrays.

**Follow-up: O(1) memory.** Row 0 and column 0 can hold the markers themselves. A failed seat at \`(r, c)\` closes row 0's seat in column \`c\` and column 0's seat in row \`r\` anyway, so writing \`0\` there loses nothing — as long as row 0 and column 0 are handled last.

1. Save two booleans: does row 0 contain a \`0\`? Does column 0 contain a \`0\`?
2. For every \`r ≥ 1\`, \`c ≥ 1\` with \`grid[r][c] == 0\`: set \`grid[r][0] = 0\` and \`grid[0][c] = 0\`.
3. For every \`r ≥ 1\`, \`c ≥ 1\`: if \`grid[r][0] == 0\` or \`grid[0][c] == 0\`, set \`grid[r][c] = 0\`.
4. Finally close row 0 and column 0 if their saved booleans say so.

The top-left seat \`grid[0][0]\` belongs to both row 0 and column 0, which is why two separate booleans are needed instead of reading \`grid[0][0]\`.

### Complexity

- Time: O(m·n) — two passes over the grid.
- Memory: O(m + n) with marker arrays, O(1) extra with the in-grid markers.

### C++

\`\`\`cpp
class Solution {
public:
    void closeBenches(vector<vector<int>>& grid) {
        int m = grid.size(), n = grid[0].size();
        vector<char> rowClosed(m, 0), colClosed(n, 0);
        for (int r = 0; r < m; ++r)              // pass 1: find, never write
            for (int c = 0; c < n; ++c)
                if (grid[r][c] == 0) rowClosed[r] = colClosed[c] = 1;
        for (int r = 0; r < m; ++r)              // pass 2: close
            for (int c = 0; c < n; ++c)
                if (rowClosed[r] || colClosed[c]) grid[r][c] = 0;
    }
};
\`\`\`

### Python

\`\`\`python
class Solution:
    def closeBenches(self, grid: List[List[int]]) -> None:
        n = len(grid[0])
        closed_rows = [0 in row for row in grid]                       # pass 1: find
        closed_cols = [any(row[c] == 0 for row in grid) for c in range(n)]
        for r, row in enumerate(grid):                                 # pass 2: close
            for c in range(n):
                if closed_rows[r] or closed_cols[c]:
                    row[c] = 0
\`\`\`
`,
  },
};
