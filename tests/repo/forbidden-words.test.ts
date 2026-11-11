import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, findFiles, gitAvailable, lineAt, readRepoFile } from "./support/repo";

/**
 * REC Code never claims that proctoring or the sandbox prevents cheating
 * (docs/CONVENTIONS.md, golden rule 8). Five absolute phrases are banned
 * everywhere — code, comments, UI strings, docs, commit messages — even in
 * negation. Say "monitored and recorded", "tamper-evident", "layered
 * containment" instead.
 *
 * The phrases are assembled from fragments at runtime so this file does not
 * contain them itself.
 */

/** Optional single separator: whitespace, ASCII hyphen or a Unicode hyphen/dash. */
const SEP = String.raw`[\s\-‐-―]?`;
const SEPS = String.raw`[\s\-‐-―]*`;
const WS = String.raw`\s+`;

interface BannedPhrase {
  /** The canonical phrase, for messages. */
  label: string;
  pattern: RegExp;
}

const BANNED: BannedPhrase[] = [
  { label: ["un", "bypass", "able"].join(""), source: ["un", "bypass", "able"].join(SEP) },
  { label: ["tamper", "proof"].join("-"), source: ["tamper", "proof"].join(SEP) },
  {
    label: ["cannot", "be", "by" + "passed"].join(" "),
    source: [String.raw`can(?:not|\s+not|'t|’t)`, "be", "by" + "passed"].join(WS),
  },
  { label: ["escape", "proof"].join("-"), source: ["escape", "proof"].join(SEP) },
  { label: ["secure", "lock" + "down"].join(" "), source: ["secure", "lock" + "down"].join(SEPS) },
].map(({ label, source }) => ({ label, pattern: new RegExp(source, "gi") }));

const TEXT_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".md",
  ".mdx",
  ".css",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".sh",
  ".prisma",
  ".sql",
  ".html",
  ".txt",
  ".conf",
  ".service",
  ".example",
];
/** Text files without a telling extension. */
const TEXT_FILE_NAMES = new Set(["Caddyfile", "Dockerfile", "README", "LICENSE"]);

const SKIPPED_FILES = new Set(["pnpm-lock.yaml"]);

function findBannedPhrases(text: string): Array<{ label: string; line: number; match: string }> {
  const hits: Array<{ label: string; line: number; match: string }> = [];
  for (const { label, pattern } of BANNED) {
    pattern.lastIndex = 0;
    for (const m of text.matchAll(pattern)) {
      hits.push({ label, line: lineAt(text, m.index), match: m[0].replace(/\s+/g, " ") });
    }
  }
  return hits.sort((a, b) => a.line - b.line);
}

function scannedFiles(): string[] {
  const byExtension = findFiles({
    extensions: TEXT_EXTENSIONS,
    exclude: (rel) => SKIPPED_FILES.has(rel.split("/").pop() ?? rel),
  });
  const byName = findFiles({ extensions: [""] }).filter((rel) => TEXT_FILE_NAMES.has(rel.split("/").pop() ?? rel));
  return [...new Set([...byExtension, ...byName])].sort();
}

describe("forbidden words", () => {
  describe("self-test", () => {
    const variants: Array<[phrase: string, sample: string]> = [
      [BANNED[0]!.label, `This sandbox is ${["un", "bypass", "able"].join("")}.`],
      [BANNED[0]!.label, `An ${["Un", "Bypass", "Able"].join("-")} lock.`],
      [BANNED[1]!.label, `A ${["tamper", "proof"].join("-")} log.`],
      [BANNED[1]!.label, `A ${["tamper", "proof"].join(" ")} log.`],
      [BANNED[1]!.label, `A ${["TAMPER", "PROOF"].join("")} log.`],
      [BANNED[1]!.label, `A ${["tamper", "proof"].join("‑")} log.`],
      [BANNED[2]!.label, `It ${["cannot", "be", "by" + "passed"].join(" ")}.`],
      [BANNED[2]!.label, `It ${["can", "not", "be", "by" + "passed"].join(" ")}.`],
      [BANNED[2]!.label, `It ${["can't", "be", "by" + "passed"].join(" ")}.`],
      [BANNED[2]!.label, `It ${["cannot", "be"].join(" ")}\n${"by" + "passed"} at all.`],
      [BANNED[3]!.label, `An ${["escape", "proof"].join("-")} box.`],
      [BANNED[3]!.label, `An ${["escape", "proof"].join(" ")} box.`],
      [BANNED[3]!.label, `An ${["escape", "proof"].join("")} box.`],
      [BANNED[4]!.label, `A ${["Secure", "Lock" + "down"].join(" ")} browser.`],
      [BANNED[4]!.label, `A ${["secure", "lock" + "down"].join("-")} mode.`],
    ];

    it.each(variants)("detects a variant of %s", (label, sample) => {
      expect(findBannedPhrases(sample).map((h) => h.label)).toContain(label);
    });

    it("reports the line of a match", () => {
      const text = `line one\nline two\nthe ${["tamper", "proof"].join("-")} part\n`;
      expect(findBannedPhrases(text)).toEqual([expect.objectContaining({ line: 3 })]);
    });

    it("does not flag the approved wording", () => {
      const approved = [
        "Assessments are monitored and recorded.",
        "The audit log is tamper-evident.",
        "Judging uses layered containment; no sandbox can be proven impossible to escape.",
        "A secure connection; lockdown mode is not offered.",
        "The escape key closes the dialog. Proof of work is not required.",
      ].join("\n");
      expect(findBannedPhrases(approved)).toEqual([]);
    });
  });

  it("no repository text file contains a banned phrase", () => {
    const files = scannedFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain("docs/CONVENTIONS.md");
    const hits = files.flatMap((file) =>
      findBannedPhrases(readRepoFile(file)).map((h) => `${file}:${h.line}  "${h.match}"  (banned: ${h.label})`),
    );
    expect(hits, "Use 'monitored and recorded', 'tamper-evident' or 'layered containment'.").toEqual([]);
  });

  it.skipIf(!gitAvailable())("no commit message contains a banned phrase", () => {
    let log: string;
    try {
      log = execFileSync("git", ["log", "--format=%H%x00%B%x01"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return; // a repository with no commits yet has no messages to scan
    }
    const hits = log
      .split("\x01")
      .map((entry) => entry.replace(/^\s+/, ""))
      .filter((entry) => entry.includes("\0"))
      .flatMap((entry) => {
        const [hash, body = ""] = entry.split("\0");
        return findBannedPhrases(body).map((h) => `commit ${hash!.slice(0, 12)} line ${h.line}  "${h.match}"`);
      });
    expect(hits).toEqual([]);
  });
});
