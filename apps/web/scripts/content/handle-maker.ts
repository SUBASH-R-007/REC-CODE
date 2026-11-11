/**
 * handle-maker (REC-0004): FUNCTION mode, EASY, Strings. Originally authored
 * for REC Code: turn a name as typed at a sign-up desk into a profile handle.
 */
import { parseType, serializeArgs, serializeValue, starterStub, type FunctionSignature } from "@recx/shared/harness";
import { prng, randomInt, type AuthoredProblem, type AuthoredTest } from "./types";

export const HANDLE_MAKER_SIGNATURE: FunctionSignature = {
  className: "Solution",
  methodName: "makeHandle",
  params: [{ name: "name", type: "string" }],
  returns: "string",
  comparator: "EXACT",
  mutatedParam: null,
};

export const MAX_NAME_LENGTH = 100_000;

const isKept = (ch: string) => /^[A-Za-z0-9]$/.test(ch);

/** The reference rule: lowercase letters and digits, one '-' per inner run of anything else. */
export function handleOf(name: string): string {
  let handle = "";
  let gap = false;
  for (const ch of name) {
    if (isKept(ch)) {
      if (gap && handle.length > 0) handle += "-";
      gap = false;
      handle += ch.toLowerCase();
    } else {
      gap = true;
    }
  }
  return handle;
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ALNUM = LETTERS + "0123456789";
/** Every printable ASCII character (codes 32–126) that is not a letter or a digit. */
const SEPARATORS = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i))
  .filter((ch) => !isKept(ch))
  .join("");

function pick(r: () => number, alphabet: string): string {
  return alphabet[Math.floor(r() * alphabet.length)]!;
}

/**
 * A random name of exactly `length` characters: words of letters and digits
 * (1..maxWord long) alternating with runs of punctuation and spaces
 * (1..maxRun long). At least one character is always kept.
 */
function randomName(length: number, options: { maxWord: number; maxRun: number }, seed: number): string {
  const r = prng(seed);
  const parts: string[] = [];
  let size = 0;
  let word = r() < 0.5;
  while (size < length) {
    const run = randomInt(r, 1, word ? options.maxWord : options.maxRun);
    let chunk = "";
    for (let i = 0; i < run; i++) chunk += pick(r, word ? ALNUM : SEPARATORS);
    parts.push(chunk);
    size += run;
    word = !word;
  }
  let name = parts.join("").slice(0, length);
  if (![...name].some(isKept)) {
    const mid = Math.floor(length / 2);
    name = name.slice(0, mid) + "x" + name.slice(mid + 1);
  }
  return name;
}

/** A name of `length` letters only, in mixed case. */
function lettersOnly(length: number, seed: number): string {
  const r = prng(seed);
  let s = "";
  for (let i = 0; i < length; i++) s += pick(r, LETTERS);
  return s;
}

const NAME_TYPE = parseType("string");

function handleMakerTests(): AuthoredTest[] {
  const cases: { name: string; isSample: boolean }[] = [
    { name: "  Priya  S. Kumar!! ", isSample: true },
    { name: "R2-D2_fan", isSample: true },
    { name: "a", isSample: false },
    { name: "Z", isSample: false },
    { name: "...7...", isSample: false },
    { name: "ALL CAPS NAME", isSample: false },
    { name: `Dr. O'Neil "Ace" \\ CSE`, isSample: false },
    { name: "2116231001001", isSample: false },
    { name: "x-_-.-_-y", isSample: false },
    { name: "___Hello___World___", isSample: false },
    { name: randomName(1000, { maxWord: 8, maxRun: 3 }, 41), isSample: false },
    { name: randomName(MAX_NAME_LENGTH, { maxWord: 12, maxRun: 4 }, 42), isSample: false },
    { name: randomName(MAX_NAME_LENGTH, { maxWord: 2, maxRun: 40 }, 43), isSample: false },
    { name: lettersOnly(MAX_NAME_LENGTH, 44), isSample: false },
    { name: "a.".repeat(MAX_NAME_LENGTH / 2), isSample: false },
    { name: " ".repeat(MAX_NAME_LENGTH / 2) + "Q" + "!".repeat(MAX_NAME_LENGTH / 2 - 1), isSample: false },
  ];
  return cases.map(({ name, isSample }) => ({
    isSample,
    subtask: null,
    input: serializeArgs([NAME_TYPE], [name]),
    output: serializeValue(NAME_TYPE, handleOf(name)) + "\n",
  }));
}

export const HANDLE_MAKER: AuthoredProblem = {
  slug: "handle-maker",
  displayCode: "REC-0004",
  title: "Handle Maker",
  difficulty: "EASY",
  topics: ["STRINGS"],
  statement: `Every REC Code profile has a **handle**: the short, lowercase name used in the profile's web address. The sign-up desk wants to suggest a handle from a student's name exactly as they typed it — extra spaces, capital letters, dots and all.

Write \`makeHandle(name)\` that builds the handle with these rules:

1. Letters are kept and written in lowercase (\`A\` becomes \`a\`). Digits are kept as they are.
2. Every other character — a space, a dot, a dash, an underscore, a quote or any other punctuation — is a **separator**.
3. Each group of separators that sits **between** two kept characters becomes a single \`-\`, however long the group is.
4. Separators at the very start or the very end of the name are dropped.

The name always contains at least one letter or digit, so the handle is never empty.

### Example 1

\`\`\`
Input:  name = "  Priya  S. Kumar!! "
Output: "priya-s-kumar"
\`\`\`

The spaces at the start and the \`!! \` at the end are dropped. The two spaces after \`Priya\` and the \`. \` after \`S\` each become one \`-\`.

### Example 2

\`\`\`
Input:  name = "R2-D2_fan"
Output: "r2-d2-fan"
\`\`\`

A \`-\` in the name is a separator too, so it simply stays a single \`-\`.`,
  constraints: [
    "1 ≤ name.length ≤ 10⁵",
    "name contains only printable ASCII characters (codes 32 to 126).",
    "name contains at least one letter or digit.",
  ],
  timeLimitMs: 1000,
  memoryLimitKb: 262_144,
  ioMode: "FUNCTION",
  signature: HANDLE_MAKER_SIGNATURE,
  compareMode: "TOKEN",
  scoringMode: "ICPC",
  stopOnFirstFailure: true,
  checkerSource: null,
  subtasks: [],
  generateTests: handleMakerTests,
  starters: {
    cpp20: starterStub("cpp20", HANDLE_MAKER_SIGNATURE),
    py312: starterStub("py312", HANDLE_MAKER_SIGNATURE),
  },
  references: [
    {
      language: "cpp20",
      label: "Model solution (one pass with a gap flag)",
      expected: "AC",
      source: `class Solution {
public:
    string makeHandle(string& name) {
        string handle;
        handle.reserve(name.size());
        bool gap = false;
        for (char c : name) {
            unsigned char u = (unsigned char)c;
            if (isalnum(u)) {
                if (gap && !handle.empty()) handle += '-';
                gap = false;
                handle += (char)tolower(u);
            } else {
                gap = true;
            }
        }
        return handle;
    }
};
`,
    },
    {
      language: "py312",
      label: "Model solution (one pass with a gap flag)",
      expected: "AC",
      source: `class Solution:
    def makeHandle(self, name: str) -> str:
        handle = []
        gap = False
        for ch in name:
            if ch.isascii() and ch.isalnum():
                if gap and handle:
                    handle.append("-")
                gap = False
                handle.append(ch.lower())
            else:
                gap = True
        return "".join(handle)
`,
    },
    {
      language: "java21",
      label: "Model solution (one pass with a gap flag)",
      expected: "AC",
      source: `class Solution {
    public String makeHandle(String name) {
        StringBuilder handle = new StringBuilder(name.length());
        boolean gap = false;
        for (int i = 0; i < name.length(); i++) {
            char c = name.charAt(i);
            boolean kept = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
            if (kept) {
                if (gap && handle.length() > 0) handle.append('-');
                gap = false;
                handle.append(Character.toLowerCase(c));
            } else {
                gap = true;
            }
        }
        return handle.toString();
    }
}
`,
    },
    {
      language: "cpp20",
      label: "Deliberately wrong: keeps a trailing dash",
      expected: "WA",
      source: `// Writes the '-' as soon as a separator group starts, so a name that ends
// with separators keeps a '-' at the end of the handle.
class Solution {
public:
    string makeHandle(string& name) {
        string handle;
        for (char c : name) {
            unsigned char u = (unsigned char)c;
            if (isalnum(u)) handle += (char)tolower(u);
            else if (!handle.empty() && handle.back() != '-') handle += '-';
        }
        return handle;
    }
};
`,
    },
  ],
  help: {
    hints: [
      `Walk through the name one character at a time and sort each character into one of two kinds: **keep** (a letter or a digit) or **separator** (anything else). Then think about a whole *group* of separators: what should it turn into, and when?`,
      `Do not write the \`-\` the moment you meet a separator. Just remember that you are *inside a gap*. Write a single \`-\` only when the next kept character arrives — and only if the handle already has something in it. Leading and trailing separators then take care of themselves.`,
      `Keep a boolean \`gap\`, initially false. For a letter or digit: if \`gap\` is true and the handle is not empty, append \`-\`; set \`gap\` to false; append the character in lowercase. For any other character: set \`gap\` to true. Return the handle. (In C++, pass \`(unsigned char)c\` to \`isalnum\` and \`tolower\`.)`,
    ],
    editorial: `### Approach

Read the name once, from left to right, and build the handle as you go. The only tricky part is deciding *when* to write a \`-\`.

If you write a \`-\` as soon as you see a separator, two things go wrong: a name that starts with spaces gets a \`-\` in front (unless you check that the handle is empty), and a name that ends with \`!!\` keeps a \`-\` at the end. Instead, **delay** the dash:

- Keep a flag \`gap\` that says "I have seen at least one separator since the last kept character".
- On a separator, just set \`gap = true\`.
- On a letter or digit, first write one \`-\` if \`gap\` is true **and** the handle is not empty, then clear \`gap\` and write the character in lowercase.

A group of separators between two words therefore becomes exactly one \`-\`; a group at the start is ignored because the handle is still empty; a group at the end is ignored because no kept character follows it.

### Complexity

- Time: O(n) — one look at each character.
- Memory: O(n) for the handle.

### C++

\`\`\`cpp
class Solution {
public:
    string makeHandle(string& name) {
        string handle;
        bool gap = false;
        for (char c : name) {
            unsigned char u = (unsigned char)c;   // isalnum/tolower need a non-negative value
            if (isalnum(u)) {
                if (gap && !handle.empty()) handle += '-';
                gap = false;
                handle += (char)tolower(u);
            } else {
                gap = true;
            }
        }
        return handle;
    }
};
\`\`\`

### Python

\`\`\`python
class Solution:
    def makeHandle(self, name: str) -> str:
        handle, gap = [], False
        for ch in name:
            if ch.isascii() and ch.isalnum():
                if gap and handle:
                    handle.append("-")
                gap = False
                handle.append(ch.lower())
            else:
                gap = True
        return "".join(handle)
\`\`\`

Once the idea is clear, Python can also say it in one line: the handle is every maximal run of lowercase letters and digits, joined by \`-\`.

\`\`\`python
import re

class Solution:
    def makeHandle(self, name: str) -> str:
        return "-".join(re.findall(r"[a-z0-9]+", name.lower()))
\`\`\`
`,
  },
};
