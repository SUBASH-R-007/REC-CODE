/**
 * conveyor-shift (REC-0007): FUNCTION mode, EASY, IN_PLACE_MUTATION on a
 * list. Originally authored for REC Code: rotate the parcels on the mailroom's
 * circular conveyor belt, rearranging the caller's list in place.
 */
import { parseType, serializeArgs, serializeValue, starterStub, type FunctionSignature } from "@recx/shared/harness";
import { prng, randomInt, type AuthoredProblem, type AuthoredTest } from "./types";

export const CONVEYOR_SHIFT_SIGNATURE: FunctionSignature = {
  className: "Solution",
  methodName: "shiftRight",
  params: [
    { name: "parcels", type: "list<int>" },
    { name: "k", type: "int" },
  ],
  returns: "void",
  comparator: "IN_PLACE_MUTATION",
  mutatedParam: "parcels",
};

export const CONVEYOR_SHIFT_LIMITS = Object.freeze({
  maxN: 100_000,
  maxCode: 1_000_000_000,
  maxK: 1_000_000_000,
});

/** The reference rule: the parcel in slot i moves to slot (i + k) mod n. */
export function shiftedRight(parcels: readonly number[], k: number): number[] {
  const n = parcels.length;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[(i + k) % n] = parcels[i]!;
  return out;
}

function randomCodes(n: number, lo: number, hi: number, seed: number): number[] {
  const r = prng(seed);
  return Array.from({ length: n }, () => randomInt(r, lo, hi));
}

const TYPES = CONVEYOR_SHIFT_SIGNATURE.params.map((p) => parseType(p.type));
const PARCELS = TYPES[0]!;

function conveyorShiftTests(): AuthoredTest[] {
  const { maxN, maxCode, maxK } = CONVEYOR_SHIFT_LIMITS;
  const cases: { parcels: number[]; k: number; isSample: boolean }[] = [
    { parcels: [11, 12, 13, 14, 15], k: 2, isSample: true },
    { parcels: [7, 3, 9], k: 4, isSample: true },
    { parcels: [42], k: 0, isSample: false },
    { parcels: [42], k: maxK, isSample: false },
    { parcels: [5, 6], k: 1, isSample: false },
    { parcels: [1, 2, 3, 4, 5, 6], k: 0, isSample: false },
    // A whole number of laps leaves the belt as it was.
    { parcels: [1, 2, 3, 4, 5, 6], k: 6, isSample: false },
    { parcels: [1, 2, 3, 4, 5, 6, 7], k: 13, isSample: false },
    { parcels: [0, 0, 1, 1, 0], k: 3, isSample: false },
    { parcels: randomCodes(1000, 0, 1000, 71), k: 999_999_999, isSample: false },
    // 10⁹ is a multiple of 10⁵: ten thousand full laps.
    { parcels: randomCodes(maxN, 0, maxCode, 72), k: maxK, isSample: false },
    { parcels: randomCodes(maxN, 0, maxCode, 73), k: 123_457, isSample: false },
    { parcels: randomCodes(maxN, 0, maxCode, 74), k: maxN - 1, isSample: false },
    { parcels: randomCodes(maxN - 9, 0, maxCode, 75), k: maxK, isSample: false },
    { parcels: randomCodes(maxN, 0, 9, 76), k: maxN / 2, isSample: false },
    { parcels: Array.from({ length: maxN }, (_, i) => maxCode - i), k: 777, isSample: false },
  ];
  return cases.map(({ parcels, k, isSample }) => ({
    isSample,
    subtask: null,
    input: serializeArgs(TYPES, [parcels, k]),
    output: serializeValue(PARCELS, shiftedRight(parcels, k)) + "\n",
  }));
}

export const CONVEYOR_SHIFT: AuthoredProblem = {
  slug: "conveyor-shift",
  displayCode: "REC-0007",
  title: "Conveyor Shift",
  difficulty: "EASY",
  topics: ["ARRAYS_HASHING", "TWO_POINTERS"],
  statement: `The campus mailroom sorts parcels on a **circular conveyor belt** with \`n\` slots, numbered \`0\` to \`n - 1\`. Slot \`i\` holds the parcel with code \`parcels[i]\`.

Every tick, each parcel moves one slot to the right: the parcel in slot \`i\` moves to slot \`i + 1\`, and the parcel in the last slot wraps around to slot \`0\`.

Write \`shiftRight(parcels, k)\` that changes \`parcels\` **in place** so that it shows the belt after \`k\` ticks. The function returns nothing: after it returns, the judge prints \`parcels\` and compares that.

### Example 1

\`\`\`
Input:  parcels = [11, 12, 13, 14, 15], k = 2
Output: [14, 15, 11, 12, 13]
\`\`\`

After one tick the belt reads \`[15, 11, 12, 13, 14]\`; after the second tick, \`[14, 15, 11, 12, 13]\`.

### Example 2

\`\`\`
Input:  parcels = [7, 3, 9], k = 4
Output: [9, 7, 3]
\`\`\`

Three ticks bring every parcel back to where it started, so four ticks look exactly like one.

### Note

Building a new list and pointing the parameter at it is **not** a change in place: in Python, \`parcels = new_list\` only rebinds your local name, and the caller still sees the old belt. Write into the list you were given (for example, \`parcels[:] = …\` in Python).

### Follow-up

Can you do it with O(1) extra memory?`,
  constraints: ["1 ≤ parcels.length ≤ 10⁵", "0 ≤ parcels[i] ≤ 10⁹", "0 ≤ k ≤ 10⁹"],
  timeLimitMs: 1000,
  memoryLimitKb: 262_144,
  ioMode: "FUNCTION",
  signature: CONVEYOR_SHIFT_SIGNATURE,
  compareMode: "TOKEN",
  scoringMode: "ICPC",
  stopOnFirstFailure: true,
  checkerSource: null,
  subtasks: [],
  generateTests: conveyorShiftTests,
  starters: {
    cpp20: starterStub("cpp20", CONVEYOR_SHIFT_SIGNATURE),
    py312: starterStub("py312", CONVEYOR_SHIFT_SIGNATURE),
  },
  references: [
    {
      language: "cpp20",
      label: "Model solution (three reversals)",
      expected: "AC",
      source: `class Solution {
public:
    void shiftRight(vector<int>& parcels, int k) {
        int n = parcels.size();
        k %= n;
        reverse(parcels.begin(), parcels.end());
        reverse(parcels.begin(), parcels.begin() + k);
        reverse(parcels.begin() + k, parcels.end());
    }
};
`,
    },
    {
      language: "py312",
      label: "Model solution (slice assignment)",
      expected: "AC",
      source: `class Solution:
    def shiftRight(self, parcels: List[int], k: int) -> None:
        k %= len(parcels)
        if k:
            parcels[:] = parcels[-k:] + parcels[:-k]
`,
    },
    {
      language: "java21",
      label: "Model solution (three reversals)",
      expected: "AC",
      source: `class Solution {
    public void shiftRight(int[] parcels, int k) {
        int n = parcels.length;
        k %= n;
        reverse(parcels, 0, n - 1);
        reverse(parcels, 0, k - 1);
        reverse(parcels, k, n - 1);
    }

    private static void reverse(int[] a, int i, int j) {
        while (i < j) {
            int t = a[i];
            a[i++] = a[j];
            a[j--] = t;
        }
    }
}
`,
    },
    {
      language: "py312",
      label: "Deliberately wrong: rebinds parcels",
      expected: "WA",
      source: `# Builds the shifted belt correctly, but only points the local name at the
# new list. The caller's list never changes.
class Solution:
    def shiftRight(self, parcels: List[int], k: int) -> None:
        k %= len(parcels)
        parcels = parcels[-k:] + parcels[:-k]
`,
    },
    {
      language: "cpp20",
      label: "Deliberately wrong: shifts left",
      expected: "WA",
      source: `// std::rotate makes the element at the middle iterator the new first
// element: that moves every parcel k slots to the LEFT.
class Solution {
public:
    void shiftRight(vector<int>& parcels, int k) {
        int n = parcels.size();
        rotate(parcels.begin(), parcels.begin() + k % n, parcels.end());
    }
};
`,
    },
  ],
  help: {
    hints: [
      `Ticks repeat in a cycle: after \`n\` ticks every parcel is back where it started. So only \`k mod n\` ticks matter — and with \`k\` up to 10⁹ you cannot simulate the ticks one by one anyway.`,
      `With \`s = k mod n\`, the parcel in slot \`i\` ends in slot \`(i + s) mod n\`. Equivalently, the last \`s\` parcels move to the front, in the same order, and the other parcels follow them. You can build that order in a second list and then copy it back into \`parcels\` — copying back is what makes the change visible to the caller.`,
      `For O(1) extra memory, use three reversals. Reverse the whole list; the last \`s\` parcels are now at the front, but backwards, and the rest follow, also backwards. Then reverse the first \`s\` elements, and finally reverse the remaining \`n - s\`. Each reversal is two pointers walking towards each other and swapping. In Python, \`parcels[:] = parcels[-s:] + parcels[:-s]\` (when \`s > 0\`) writes into the caller's list; \`parcels = …\` would not.`,
    ],
    editorial: `### Approach

**Reduce \`k\`.** After \`n\` ticks the belt is back where it started, so only \`s = k mod n\` ticks matter. Simulating tick by tick costs O(n·s), which is up to 10¹⁰ steps — far too slow.

**Where does each parcel go?** After \`s\` ticks, the parcel from slot \`i\` sits in slot \`(i + s) mod n\`. Read the other way round: the last \`s\` parcels come first, then the first \`n - s\` parcels, each group in its original order. A second list can hold that order, and copying it back into \`parcels\` finishes the job in O(n) time and O(n) memory.

**In place, O(1) memory: three reversals.** Write the belt as two blocks, \`A\` (the first \`n - s\` parcels) followed by \`B\` (the last \`s\`). We want \`B A\`.

1. Reverse everything: \`A B\` becomes \`rev(B) rev(A)\`.
2. Reverse the first \`s\` elements: \`rev(B)\` becomes \`B\`.
3. Reverse the last \`n - s\` elements: \`rev(A)\` becomes \`A\`.

The result is \`B A\`. Each reversal is two pointers that start at the ends of a range, swap, and step towards each other.

**In place really means in place.** The judge prints the list it passed to you. In Python, \`parcels = parcels[-s:] + parcels[:-s]\` builds the right belt but only rebinds your local name, so the caller sees no change. Slice assignment, \`parcels[:] = …\`, writes into the caller's list.

### Complexity

- Time: O(n) — every element is swapped at most twice.
- Memory: O(1) extra with the reversals (O(n) with a temporary list or Python's slices).

### C++

\`\`\`cpp
class Solution {
public:
    void shiftRight(vector<int>& parcels, int k) {
        int n = parcels.size();
        k %= n;                                        // whole laps change nothing
        reverse(parcels.begin(), parcels.end());       // A B  ->  rev(B) rev(A)
        reverse(parcels.begin(), parcels.begin() + k); // rev(B) -> B
        reverse(parcels.begin() + k, parcels.end());   // rev(A) -> A
    }
};
\`\`\`

### Python

\`\`\`python
class Solution:
    def shiftRight(self, parcels: List[int], k: int) -> None:
        k %= len(parcels)
        if k:
            # Slice assignment writes into the caller's list.
            parcels[:] = parcels[-k:] + parcels[:-k]
\`\`\`
`,
  },
};
