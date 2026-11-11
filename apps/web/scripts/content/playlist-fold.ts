/**
 * playlist-fold (REC-0008): FUNCTION mode, MEDIUM, IN_PLACE_MUTATION on a
 * linked list. Originally authored for REC Code: relink the common-room
 * playlist so it alternates between the front and the back.
 *
 * The head node stays first on purpose. A parameter that is reassigned inside
 * the method is invisible to the caller in C++, Python and Java alike, so the
 * judge can only print the list from the node it passed in.
 */
import { parseType, serializeArgs, serializeValue, starterStub, type FunctionSignature } from "@recx/shared/harness";
import { prng, randomInt, type AuthoredProblem, type AuthoredTest } from "./types";

export const PLAYLIST_FOLD_SIGNATURE: FunctionSignature = {
  className: "Solution",
  methodName: "foldPlaylist",
  params: [{ name: "head", type: "ListNode" }],
  returns: "void",
  comparator: "IN_PLACE_MUTATION",
  mutatedParam: "head",
};

export const PLAYLIST_FOLD_LIMITS = Object.freeze({
  maxN: 100_000,
  maxSong: 1_000_000,
});

/** The reference order: first, last, second, second-to-last, … */
export function foldedOrder(songs: readonly number[]): number[] {
  const out: number[] = [];
  let lo = 0;
  let hi = songs.length - 1;
  while (lo <= hi) {
    out.push(songs[lo++]!);
    if (lo <= hi) out.push(songs[hi--]!);
  }
  return out;
}

function randomSongs(n: number, seed: number): number[] {
  const r = prng(seed);
  return Array.from({ length: n }, () => randomInt(r, 1, PLAYLIST_FOLD_LIMITS.maxSong));
}

const HEAD = parseType(PLAYLIST_FOLD_SIGNATURE.params[0]!.type);

function playlistFoldTests(): AuthoredTest[] {
  const { maxN } = PLAYLIST_FOLD_LIMITS;
  const upTo = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
  const cases: { songs: number[]; isSample: boolean }[] = [
    { songs: [10, 20, 30, 40, 50], isSample: true },
    { songs: [4, 9, 2, 6], isSample: true },
    { songs: [5], isSample: false },
    { songs: [5, 8], isSample: false },
    { songs: [1, 2, 3], isSample: false },
    { songs: [3, 1, 4, 1, 5, 9], isSample: false },
    { songs: upTo(10), isSample: false },
    { songs: upTo(11), isSample: false },
    { songs: randomSongs(1000, 81), isSample: false },
    { songs: randomSongs(maxN, 82), isSample: false },
    { songs: randomSongs(maxN - 1, 83), isSample: false },
    { songs: upTo(maxN), isSample: false },
    { songs: Array.from({ length: maxN }, () => 7), isSample: false },
    { songs: Array.from({ length: maxN - 1 }, (_, i) => (i % 2 === 0 ? 1 : PLAYLIST_FOLD_LIMITS.maxSong)), isSample: false },
  ];
  return cases.map(({ songs, isSample }) => ({
    isSample,
    subtask: null,
    input: serializeArgs([HEAD], [songs]),
    output: serializeValue(HEAD, foldedOrder(songs)) + "\n",
  }));
}

export const PLAYLIST_FOLD: AuthoredProblem = {
  slug: "playlist-fold",
  displayCode: "REC-0008",
  title: "Playlist Fold",
  difficulty: "MEDIUM",
  topics: ["LINKED_LIST", "TWO_POINTERS"],
  statement: `The music player in the hostel common room keeps its playlist as a **singly linked list**: each node holds a song id in \`val\` and points to the next song with \`next\`.

On Friday nights the cultural club wants a **folded** playlist, alternating between the front and the back of the list: the first song, then the last song, then the second song, then the second-to-last song, and so on until every song has been played exactly once.

Write \`foldPlaylist(head)\` that relinks the playlist **in place** into the folded order. The first song stays first, so \`head\` is still the start of the playlist. The function returns nothing: after it returns, the judge prints the playlist starting from \`head\`.

### Example 1

\`\`\`
Input:  head = [10, 20, 30, 40, 50]
Output: [10, 50, 20, 40, 30]
\`\`\`

First \`10\`, last \`50\`, second \`20\`, second-to-last \`40\`, and the middle song \`30\` closes the night.

### Example 2

\`\`\`
Input:  head = [4, 9, 2, 6]
Output: [4, 6, 9, 2]
\`\`\`

### Note

Change the \`next\` pointers of the nodes you were given; the judge defines \`ListNode\` for you. Make sure the last song of the folded playlist points to nothing, or the playlist will never end.`,
  constraints: [
    "The playlist has between 1 and 10⁵ songs.",
    "1 ≤ val ≤ 10⁶ (song ids may repeat).",
  ],
  timeLimitMs: 1000,
  memoryLimitKb: 262_144,
  ioMode: "FUNCTION",
  signature: PLAYLIST_FOLD_SIGNATURE,
  compareMode: "TOKEN",
  scoringMode: "ICPC",
  stopOnFirstFailure: true,
  checkerSource: null,
  subtasks: [],
  generateTests: playlistFoldTests,
  starters: {
    cpp20: starterStub("cpp20", PLAYLIST_FOLD_SIGNATURE),
    py312: starterStub("py312", PLAYLIST_FOLD_SIGNATURE),
  },
  references: [
    {
      language: "cpp20",
      label: "Model solution (middle, reverse, merge)",
      expected: "AC",
      source: `class Solution {
public:
    void foldPlaylist(ListNode* head) {
        if (!head || !head->next) return;
        // 1. Find the end of the first half.
        ListNode* slow = head;
        ListNode* fast = head;
        while (fast->next && fast->next->next) {
            slow = slow->next;
            fast = fast->next->next;
        }
        // 2. Cut after it and reverse the second half.
        ListNode* back = nullptr;
        ListNode* cur = slow->next;
        slow->next = nullptr;
        while (cur) {
            ListNode* nxt = cur->next;
            cur->next = back;
            back = cur;
            cur = nxt;
        }
        // 3. Weave the reversed back half into the front half.
        ListNode* front = head;
        while (back) {
            ListNode* frontNext = front->next;
            ListNode* backNext = back->next;
            front->next = back;
            back->next = frontNext;
            front = frontNext;
            back = backNext;
        }
    }
};
`,
    },
    {
      language: "py312",
      label: "Model solution (middle, reverse, merge)",
      expected: "AC",
      source: `class Solution:
    def foldPlaylist(self, head: Optional[ListNode]) -> None:
        if head is None or head.next is None:
            return
        slow = fast = head
        while fast.next is not None and fast.next.next is not None:
            slow = slow.next
            fast = fast.next.next
        back = None
        cur = slow.next
        slow.next = None
        while cur is not None:
            cur.next, back, cur = back, cur, cur.next
        front = head
        while back is not None:
            front_next, back_next = front.next, back.next
            front.next = back
            back.next = front_next
            front, back = front_next, back_next
`,
    },
    {
      language: "java21",
      label: "Model solution (middle, reverse, merge)",
      expected: "AC",
      source: `class Solution {
    public void foldPlaylist(ListNode head) {
        if (head == null || head.next == null) return;
        ListNode slow = head, fast = head;
        while (fast.next != null && fast.next.next != null) {
            slow = slow.next;
            fast = fast.next.next;
        }
        ListNode back = null, cur = slow.next;
        slow.next = null;
        while (cur != null) {
            ListNode nxt = cur.next;
            cur.next = back;
            back = cur;
            cur = nxt;
        }
        ListNode front = head;
        while (back != null) {
            ListNode frontNext = front.next, backNext = back.next;
            front.next = back;
            back.next = frontNext;
            front = frontNext;
            back = backNext;
        }
    }
}
`,
    },
    {
      language: "cpp20",
      label: "Deliberately wrong: interleaves the halves without reversing",
      expected: "WA",
      source: `// Splits the playlist in the middle correctly, but weaves the second half in
// its original order: first, middle, second, middle + 1, ... instead of
// first, last, second, second-to-last, ...
class Solution {
public:
    void foldPlaylist(ListNode* head) {
        if (!head || !head->next) return;
        ListNode* slow = head;
        ListNode* fast = head;
        while (fast->next && fast->next->next) {
            slow = slow->next;
            fast = fast->next->next;
        }
        ListNode* back = slow->next;
        slow->next = nullptr;
        ListNode* front = head;
        while (back) {
            ListNode* frontNext = front->next;
            ListNode* backNext = back->next;
            front->next = back;
            back->next = frontNext;
            front = frontNext;
            back = backNext;
        }
    }
};
`,
    },
  ],
  help: {
    hints: [
      `Look at the folded order as two lists woven together: the front half of the playlist, read forwards, and the back half, read **backwards**. If you had the back half reversed, you would only have to alternate between the two.`,
      `Three steps, all in place. Find the end of the front half with two pointers — \`slow\` moves one node, \`fast\` moves two, and when \`fast\` cannot move on, \`slow\` is the last node of the front half. Cut the list after \`slow\` and reverse the back half by flipping its \`next\` pointers. Then weave: front, back, front, back, …`,
      `Step 1: \`slow = fast = head\`; while \`fast.next\` and \`fast.next.next\` exist, move \`slow\` once and \`fast\` twice. Step 2: \`cur = slow.next\`, set \`slow.next = null\` (this also makes the last song point to nothing), and reverse from \`cur\` with the usual \`prev\`/\`cur\`/\`next\` loop. Step 3: with \`front = head\` and \`back\` = the reversed half, repeat while \`back\` is not null: save both \`next\` pointers, set \`front.next = back\` and \`back.next = savedFront\`, then advance both. The front half is never shorter than the back half, so it simply ends where it should. No recursion is needed — with 10⁵ songs, a recursive version can overflow the stack.`,
    ],
    editorial: `### Approach

The folded playlist alternates between two sequences: the front half of the list in its normal order, and the back half in **reverse** order. For \`[10, 20, 30, 40, 50]\` the front half is \`10, 20, 30\` and the back half reversed is \`50, 40\`; alternating gives \`10, 50, 20, 40, 30\`.

A singly linked list cannot be walked backwards, so we reverse the back half ourselves, without any extra list:

1. **Find the middle.** Walk \`slow\` one node at a time and \`fast\` two nodes at a time, while \`fast.next\` and \`fast.next.next\` both exist. When the loop stops, \`slow\` is the last node of the front half; the front half has \`⌈n/2⌉\` nodes.
2. **Cut and reverse.** Remember \`slow.next\` as the start of the back half and set \`slow.next = null\`, so the front half ends there. Reverse the back half by turning every \`next\` pointer around.
3. **Weave.** Take one node from the front, one from the reversed back, and so on. Before relinking, save both \`next\` pointers. Because the front half has as many nodes as the back half, or one more, the loop ends when the back half runs out, and the last node already points to \`null\`.

The head node stays first throughout, so the caller's \`head\` still starts the folded playlist.

A common mistake is to skip step 2 and weave the back half in its original order. That gives first, middle, second, middle + 1, …, which is wrong as soon as the playlist has four songs.

### Complexity

- Time: O(n) — each step walks the list at most once.
- Memory: O(1) extra — only a few pointers. (Copying the songs into an array and rebuilding the links also works, with O(n) memory.)

### C++

\`\`\`cpp
class Solution {
public:
    void foldPlaylist(ListNode* head) {
        if (!head || !head->next) return;
        ListNode *slow = head, *fast = head;
        while (fast->next && fast->next->next) { slow = slow->next; fast = fast->next->next; }

        ListNode *back = nullptr, *cur = slow->next;
        slow->next = nullptr;                       // the front half ends here
        while (cur) { ListNode* nxt = cur->next; cur->next = back; back = cur; cur = nxt; }

        for (ListNode* front = head; back; ) {      // weave front, back, front, back, ...
            ListNode *fn = front->next, *bn = back->next;
            front->next = back;
            back->next = fn;
            front = fn;
            back = bn;
        }
    }
};
\`\`\`

### Python

\`\`\`python
class Solution:
    def foldPlaylist(self, head: Optional[ListNode]) -> None:
        if head is None or head.next is None:
            return
        slow = fast = head
        while fast.next and fast.next.next:
            slow, fast = slow.next, fast.next.next

        back, cur = None, slow.next
        slow.next = None                      # the front half ends here
        while cur:
            cur.next, back, cur = back, cur, cur.next

        front = head
        while back:                           # weave front, back, front, back, ...
            front_next, back_next = front.next, back.next
            front.next, back.next = back, front_next
            front, back = front_next, back_next
\`\`\`
`,
  },
};
