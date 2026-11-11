import { describe, expect, it } from "vitest";
import { CODE_EXTENSIONS, findFiles, isTestPath, lexSource, lineAt, readRepoFile } from "./support/repo";

/**
 * Three promises the discussion makes, fenced where a reviewer can see
 * them in a diff (Phase 12d).
 *
 *   1. **No discussion inside a sitting.** A candidate was told nobody is
 *      helping them. A tab in the arena that imported the discussion would
 *      break that in a way no behavioural test would catch until somebody
 *      sat an exam.
 *
 *   2. **Hidden, never deleted.** A moderator's tools are hide, un-hide
 *      and recommend. The moment any request path can delete a post, the
 *      author's appeal has nothing to look at and the "hidden by a TA,
 *      here is why" notice becomes a sometimes-notice. The nightly purge
 *      and the seed are not request paths and are not scanned.
 *
 *   3. **One decider.** The posting rule — an unassisted solve — lives in
 *      `discussionAccess()` and is reached through `discussionAllowed()`
 *      on the help chokepoint. A second place that reads
 *      `UserProblemStatus.assisted` to decide who may post is how the two
 *      answers drift apart.
 */

const SEALED = [
  "apps/web/src/app/(exam)",
  "apps/web/src/components/exam",
  "apps/web/src/app/(student)/contests",
  "apps/web/src/components/contests",
  "apps/web/src/lib/exam",
  "apps/web/src/lib/contests",
];

const DISCUSSION_MODULE = /(^|[/@])(lib\/discussion\/|components\/discussion\/|actions\/discussion|actions\/moderation|queries\/discussion)/;

function importSpecifiers(code: string): Array<{ spec: string; index: number }> {
  const out: Array<{ spec: string; index: number }> = [];
  const patterns = [
    /\bimport\s+[^;'"]*?from\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bexport\s+[^;'"]*?from\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) out.push({ spec: match[1]!, index: match.index ?? 0 });
  }
  return out;
}

export function discussionImports(file: string, source: string): string[] {
  const { code } = lexSource(source);
  return importSpecifiers(code)
    .filter(({ spec }) => DISCUSSION_MODULE.test(spec))
    .map(({ spec, index }) => `${file}:${lineAt(code, index)}  ${spec}`);
}

const DELETE_CALL =
  /\b(?:discussionPost|doubtThread|doubtReply|contentReport)\b["'`]?\]?\s*\??\.\s*(delete|deleteMany)\s*\(/g;
const SQL_DELETE = /\bDELETE\s+FROM\s+(?:"?public"?\.)?"?(?:DiscussionPost|DoubtThread|DoubtReply|ContentReport)"?/i;

export function deleteCalls(file: string, source: string): string[] {
  const { code, strings } = lexSource(source);
  const found: string[] = [];
  for (const match of code.matchAll(DELETE_CALL)) found.push(`${file}:${lineAt(code, match.index)}  ${match[0]}`);
  for (const span of strings) {
    if (SQL_DELETE.test(span.body)) found.push(`${file}:${lineAt(code, span.start)}  raw SQL delete`);
  }
  return found;
}

describe("detector self-test", () => {
  it.each([
    ['import { loadDiscussionPanel } from "@/server/queries/discussion";'],
    ['import { DiscussionBoard } from "@/components/discussion/discussion-board";'],
    ['const m = await import("@/lib/discussion/posts");'],
  ])("flags the import %s", (snippet) => {
    expect(discussionImports("x.ts", snippet)).toHaveLength(1);
  });

  it.each([['import { getHelpState } from "@/lib/help/access";'], ['// import "@/lib/discussion/posts";']])(
    "ignores the import %s",
    (snippet) => {
      expect(discussionImports("x.ts", snippet)).toEqual([]);
    },
  );

  it.each([
    ["db.discussionPost.delete({ where })"],
    ["await tx.doubtThread.deleteMany({ where })"],
    ['tx.$executeRaw`DELETE FROM "DiscussionPost" WHERE id = ${id}`'],
  ])("flags the delete %s", (snippet) => {
    expect(deleteCalls("x.ts", snippet)).toHaveLength(1);
  });

  it.each([["db.discussionPost.update({ data: { status: 'HIDDEN' } })"], ["// db.doubtThread.delete()"]])(
    "ignores the delete %s",
    (snippet) => {
      expect(deleteCalls("x.ts", snippet)).toEqual([]);
    },
  );
});

describe("the discussion cannot be reached from a sitting", () => {
  const files = findFiles({ under: SEALED, extensions: [...CODE_EXTENSIONS], exclude: isTestPath });

  it("scans the sealed trees (sanity)", () => {
    expect(files.length).toBeGreaterThan(30);
    expect(files.some((f) => f.startsWith("apps/web/src/app/(exam)"))).toBe(true);
  });

  it("imports nothing from the discussion", () => {
    expect(files.flatMap((f) => discussionImports(f, readRepoFile(f)))).toEqual([]);
  });
});

describe("hidden, never deleted", () => {
  const files = findFiles({ under: ["apps/web/src"], extensions: [".ts", ".tsx"], exclude: isTestPath });

  it("no request path deletes a post, a question, a reply or a report", () => {
    expect(files.flatMap((f) => deleteCalls(f, readRepoFile(f)))).toEqual([]);
  });

  it("hiding writes a reason, and un-hiding clears all three fields together", () => {
    const moderation = readRepoFile("apps/web/src/lib/discussion/moderation.ts");
    expect(moderation).toContain('status: "HIDDEN", hiddenById: moderatorId, hiddenReason: reason');
    expect(moderation).toContain('status: "VISIBLE", hiddenById: null, hiddenReason: null, hiddenAt: null');
  });
});

describe("one decider", () => {
  const files = findFiles({ under: ["apps/web/src"], extensions: [".ts", ".tsx"], exclude: isTestPath });

  it("discussionAccess() is called from the chokepoint and nowhere else", () => {
    const callers = files.filter((f) => /\bdiscussionAccess\s*\(/.test(lexSource(readRepoFile(f)).code));
    expect(callers).toEqual(["apps/web/src/lib/help/access.ts"]);
  });

  /**
   * Every write path in the discussion library either asks the gate or is
   * named here with the reason it does not. The list is the point: adding
   * a function to that module and forgetting the gate fails the build, and
   * adding it to the list is a line a reviewer reads.
   */
  const UNGATED: Readonly<Record<string, string>> = {
    // Being stuck is the reason to ask, so a solve gate here would gate the
    // thing the gate exists to help. Practice-only is still checked.
    askDoubtFor: "a doubt is not gated on a solve",
    // Governed by mayReplyToDoubt (the asker or a mentor), which is a
    // stricter rule than the solve gate rather than a looser one.
    replyToDoubtFor: "the asker and a mentor only",
    // Both act on a row the caller already owns, named by its own id.
    acceptAnswerFor: "the asker marks their own thread",
    editPostFor: "the author edits their own post",
    // A gate on the safety valve is not a safety valve.
    reportContentFor: "anybody signed in may report",
  };

  it("every write path in lib/discussion/posts.ts asks the gate, or is listed with its reason", () => {
    const { code } = lexSource(readRepoFile("apps/web/src/lib/discussion/posts.ts"));
    const bodies = [...code.matchAll(/export async function (\w+)\(/g)];
    expect(bodies.length, "exported write paths").toBeGreaterThanOrEqual(6);
    const missing: string[] = [];
    for (const [index, match] of bodies.entries()) {
      const name = match[1]!;
      const end = index + 1 < bodies.length ? bodies[index + 1]!.index : code.length;
      const body = code.slice(match.index, end);
      if (/\bgate\(/.test(body) || name in UNGATED) continue;
      missing.push(name);
    }
    expect(missing).toEqual([]);
  });
});
