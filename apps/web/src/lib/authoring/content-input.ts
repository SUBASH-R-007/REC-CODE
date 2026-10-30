import "server-only";
import type { Db, DbTx } from "@recx/db";
import { versionContentIssues, type ContentIssue, type VersionContentInput } from "@recx/shared/authoring";

/**
 * The rows versionContentIssues() judges, read for one revision. Blob
 * content is never loaded: a blob is inline exactly when it has no storage
 * key (src/lib/testdata/blobs.ts), so sizes and keys are enough.
 */
export async function loadVersionContentInput(client: Db | DbTx, versionId: string): Promise<VersionContentInput | null> {
  const v = await client.problemVersion.findUnique({
    where: { id: versionId },
    select: {
      ioMode: true,
      compareMode: true,
      sqlDialect: true,
      sqlOrdered: true,
      floatEpsilon: true,
      functionSignature: true,
      checkerSha256: true,
      interactorSha256: true,
      testlibId: true,
      scoringMode: true,
      timeLimitMs: true,
      memoryLimitKb: true,
      maxEditedLines: true,
      statementMd: true,
      testCases: {
        orderBy: { index: "asc" },
        select: {
          index: true,
          isSample: true,
          subtaskIndex: true,
          points: true,
          input: { select: { sizeBytes: true, storageKey: true } },
          output: { select: { sizeBytes: true, storageKey: true } },
        },
      },
      subtasks: { orderBy: { index: "asc" }, select: { index: true, points: true, dependsOn: true } },
      referenceSolutions: { select: { language: true, expectedVerdict: true } },
    },
  });
  if (!v) return null;
  /**
   * Phase 12m. A debugging version's rules are about SOURCE — the broken
   * program, and whether the author's own fix fits the budget — so for one
   * of those, and only for one of those, the starters and the model
   * solutions are read. Every other problem's gate is unchanged, and no
   * reference solution's source is loaded for it.
   */
  const debugging = v.maxEditedLines !== null;
  const starters = debugging
    ? await client.starterCode.findMany({
        where: { problemVersionId: versionId },
        select: { language: true, code: true },
      })
    : [];
  const sources = debugging
    ? await client.referenceSolution.findMany({
        where: { problemVersionId: versionId, expectedVerdict: "AC" },
        select: { language: true, source: true },
      })
    : [];
  const sourceFor = new Map(sources.map((r) => [r.language, r.source]));
  return {
    ioMode: v.ioMode,
    compareMode: v.compareMode,
    sqlDialect: v.sqlDialect,
    sqlOrdered: v.sqlOrdered,
    floatEpsilon: v.floatEpsilon,
    functionSignature: v.functionSignature,
    checkerSha256: v.checkerSha256,
    interactorSha256: v.interactorSha256,
    testlibId: v.testlibId,
    scoringMode: v.scoringMode,
    timeLimitMs: v.timeLimitMs,
    memoryLimitKb: v.memoryLimitKb,
    statementMd: v.statementMd,
    tests: v.testCases.map((t) => ({
      index: t.index,
      isSample: t.isSample,
      subtaskIndex: t.subtaskIndex,
      points: t.points,
      inputBytes: t.input.sizeBytes,
      outputBytes: t.output.sizeBytes,
      sampleInlineable: t.input.storageKey === null && t.output.storageKey === null,
    })),
    subtasks: v.subtasks,
    references: v.referenceSolutions.map((r) =>
      r.expectedVerdict === "AC" && sourceFor.has(r.language)
        ? { ...r, source: sourceFor.get(r.language) }
        : r,
    ),
    starters,
    maxEditedLines: v.maxEditedLines,
  };
}

/** The content issues of a revision (empty when it does not exist). */
export async function versionIssues(client: Db | DbTx, versionId: string): Promise<ContentIssue[]> {
  const input = await loadVersionContentInput(client, versionId);
  return input ? versionContentIssues(input) : [];
}
