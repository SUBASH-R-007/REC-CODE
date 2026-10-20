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
      floatEpsilon: true,
      functionSignature: true,
      checkerSha256: true,
      testlibId: true,
      scoringMode: true,
      timeLimitMs: true,
      memoryLimitKb: true,
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
  return {
    ioMode: v.ioMode,
    compareMode: v.compareMode,
    floatEpsilon: v.floatEpsilon,
    functionSignature: v.functionSignature,
    checkerSha256: v.checkerSha256,
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
    references: v.referenceSolutions,
  };
}

/** The content issues of a revision (empty when it does not exist). */
export async function versionIssues(client: Db | DbTx, versionId: string): Promise<ContentIssue[]> {
  const input = await loadVersionContentInput(client, versionId);
  return input ? versionContentIssues(input) : [];
}
