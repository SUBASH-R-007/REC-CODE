/**
 * Editor snapshots (Phase 6c). Pure: the delta format, its inverse, and the
 * SNAPSHOT_JUMP derivation. No I/O.
 *
 * SPEC §5 calls these "the most probative artefact", and says why:
 *
 *   Server-derived SNAPSHOT_JUMP: one 30-second interval introduces ≥60% of
 *   the final accepted solution's token count with no corresponding paste or
 *   programmatic-insert event — i.e. code appeared while the instrumentation
 *   was blind, which is precisely the footprint of a suppressed-telemetry
 *   paste. [...] It is the one piece of evidence that survives client
 *   tampering, because the answer has to reach the server to be graded. It
 *   also exonerates: a timeline growing four lines a minute with failed runs
 *   in between is a student working.
 *
 * "It also exonerates" is why the reconstruction has to be exact rather than
 * approximate: the timeline is shown to a student in their own report and in
 * an appeal, and a reconstruction that drops a line is a reconstruction
 * nobody can defend.
 */

// ── The delta format ─────────────────────────────────────────────────────

/**
 * A line patch: keep n lines, drop n lines, or insert these lines.
 *
 * SPEC §5 says "unified diffs". This is a compact line patch rather than
 * literal `diff -u` text, because the operative requirement is
 * "reconstructed on read" and this format round-trips EXACTLY by
 * construction — no hunk headers to parse, no ambiguity about trailing
 * newlines, and `applyLinePatch(from, diffLines(from, to)) === to` is a
 * property a test can assert over arbitrary inputs. Recorded in
 * docs/OPEN-QUESTIONS.md. The stored `contentHash` is the independent check
 * that a reconstruction is right.
 */
export type LinePatchOp = ["=", number] | ["-", number] | ["+", string[]];
export type LinePatch = LinePatchOp[];

/** Split that round-trips through join("\n") for every input, including "". */
const splitLines = (text: string): string[] => text.split("\n");

/**
 * The longest common subsequence of two line arrays, as a patch.
 *
 * Dynamic programming over lines, which is O(n·m) and fine here: a snapshot
 * is capped at 64 KB and code files are a few hundred lines. The cap is the
 * reason this can be the simple algorithm rather than Myers.
 */
export function diffLines(from: string, to: string): LinePatch {
  const a = splitLines(from);
  const b = splitLines(to);

  // lcs[i][j] = length of the LCS of a[i..] and b[j..]
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const patch: LinePatch = [];
  /** Append, merging with the previous op of the same kind so the patch stays small. */
  const push = (op: LinePatchOp) => {
    const last = patch[patch.length - 1];
    if (last && last[0] === op[0]) {
      if (op[0] === "+") {
        (last[1] as string[]).push(...(op[1] as string[]));
        return;
      }
      (last as ["=" | "-", number])[1] += op[1] as number;
      return;
    }
    patch.push(op);
  };

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push(["=", 1]);
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      push(["-", 1]);
      i++;
    } else {
      push(["+", [b[j]!]]);
      j++;
    }
  }
  if (i < a.length) push(["-", a.length - i]);
  if (j < b.length) push(["+", b.slice(j)]);
  return patch;
}

/**
 * Rebuild the later text from the earlier one and the patch.
 *
 * Throws rather than guessing on a patch that does not fit: a snapshot
 * timeline that silently reconstructs the wrong thing is worse than one that
 * reports it cannot.
 */
export function applyLinePatch(from: string, patch: LinePatch): string {
  const a = splitLines(from);
  const out: string[] = [];
  let i = 0;
  for (const op of patch) {
    if (op[0] === "=") {
      const n = op[1];
      if (i + n > a.length) throw new Error("patch does not fit: keep runs past the end of the source");
      out.push(...a.slice(i, i + n));
      i += n;
    } else if (op[0] === "-") {
      const n = op[1];
      if (i + n > a.length) throw new Error("patch does not fit: delete runs past the end of the source");
      i += n;
    } else {
      out.push(...op[1]);
    }
  }
  if (i !== a.length) throw new Error("patch does not fit: source lines left over");
  return out.join("\n");
}

export function serialiseLinePatch(patch: LinePatch): string {
  return JSON.stringify(patch);
}

/** Parse a stored patch. Throws on anything that is not one. */
export function parseLinePatch(text: string): LinePatch {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("not a line patch");
  for (const op of parsed) {
    if (!Array.isArray(op) || op.length !== 2) throw new Error("not a line patch");
    const [kind, value] = op as [unknown, unknown];
    if (kind === "=" || kind === "-") {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error("not a line patch");
    } else if (kind === "+") {
      if (!Array.isArray(value) || value.some((l) => typeof l !== "string")) throw new Error("not a line patch");
    } else {
      throw new Error("not a line patch");
    }
  }
  return parsed as LinePatch;
}

/**
 * Rebuild every version in a question's timeline, oldest first. The first
 * entry must be whole; each later one is a patch against the previous.
 */
export function reconstructTimeline(
  entries: readonly { readonly content: string; readonly isDiff: boolean }[],
): string[] {
  const out: string[] = [];
  let current = "";
  for (const [index, entry] of entries.entries()) {
    if (!entry.isDiff) {
      if (index > 0 && out.length === 0) throw new Error("timeline starts with a diff");
      current = entry.content;
    } else {
      if (index === 0) throw new Error("timeline starts with a diff");
      current = applyLinePatch(current, parseLinePatch(entry.content));
    }
    out.push(current);
  }
  return out;
}

// ── SNAPSHOT_JUMP ────────────────────────────────────────────────────────

/**
 * A coarse token count: identifiers and numbers, string literals as one
 * token each, and every other non-space character as its own token.
 *
 * Deliberately crude, and language-agnostic on purpose. SNAPSHOT_JUMP needs
 * a RATIO between two snapshots of the same file in the same language, not a
 * parse — and the proper lexing the spec specifies (web-tree-sitter, for
 * similarity detection) is a different job with a different budget. Comments
 * are not stripped, which makes this conservative in the right direction: a
 * candidate who pastes a commented block counts MORE tokens, not fewer, and
 * the threshold is about code appearing, not about how good it is.
 */
export function countTokens(source: string): number {
  let count = 0;
  let i = 0;
  const n = source.length;
  const isWord = (c: string) => /[A-Za-z0-9_$]/.test(c);
  while (i < n) {
    const c = source[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      // A string literal is one token however long it is, so a pasted block
      // of prose does not read as a thousand tokens of code.
      const quote = c;
      i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === "\\") i++;
        i++;
      }
      i++;
      count++;
      continue;
    }
    if (isWord(c)) {
      while (i < n && isWord(source[i]!)) i++;
      count++;
      continue;
    }
    i++;
    count++;
  }
  return count;
}

/** A jump needs this share of the final solution to appear in one interval. */
export const SNAPSHOT_JUMP_SHARE = 0.6;

/**
 * Minimum final size before a jump means anything. Below this, "60% appeared
 * at once" describes someone typing the first two lines of a five-line
 * answer, which is not a signal about anything.
 */
export const SNAPSHOT_JUMP_MIN_FINAL_TOKENS = 40;

export interface SnapshotJumpInput {
  /** Tokens added between the two consecutive snapshots. */
  readonly addedTokens: number;
  /** Tokens in the final submitted solution. */
  readonly finalTokens: number;
  /**
   * Did a paste or a programmatic-insert event land in the same interval?
   * If so this is an ORDINARY paste, already recorded as itself, and the
   * instrumentation was not blind — so there is nothing to derive.
   */
  readonly hadPasteOrProgrammaticInsert: boolean;
  /** PROGRAMMATIC_INSERT exempt for this candidate (e.g. SPEECH_INPUT). */
  readonly exempt?: boolean;
}

/**
 * Did code appear while the instrumentation was blind?
 *
 * True is not a finding. It is the one observation that survives a tampered
 * client, and it goes to a human alongside everything else — SPEC §0 caps the
 * automatic consequence at a flag and a withheld leaderboard place, and
 * nothing in this module can reach further than returning `true`.
 */
export function isSnapshotJump(input: SnapshotJumpInput): boolean {
  if (input.exempt === true) return false;
  if (input.hadPasteOrProgrammaticInsert) return false;
  if (!Number.isFinite(input.addedTokens) || !Number.isFinite(input.finalTokens)) return false;
  if (input.finalTokens < SNAPSHOT_JUMP_MIN_FINAL_TOKENS) return false;
  if (input.addedTokens <= 0) return false;
  return input.addedTokens >= input.finalTokens * SNAPSHOT_JUMP_SHARE;
}
