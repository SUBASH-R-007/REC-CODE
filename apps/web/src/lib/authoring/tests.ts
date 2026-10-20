import "server-only";
import type { SubtaskAggregation } from "@recx/db";
import { IMPORT_LIMITS } from "@recx/shared/authoring";
import { db } from "@/lib/db";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { ensureTestBlob } from "@/lib/testdata/blobs";
import { getTestDataStore } from "@/lib/testdata/store";
import { touchDraft, type DraftHead } from "./draft";
import { retryingTransaction } from "./retry";

export { testSetFingerprint } from "./fingerprint";

/**
 * Test-case edits of a DRAFT revision. Every one is a "judging" edit through
 * touchDraft (bumps judgeSeq, cancels running validation). Blobs are
 * content-addressed and written before the transaction (idempotent), so a
 * failed edit at worst leaves an unreferenced blob.
 */

export interface NewTest {
  input: Buffer;
  output: Buffer;
  isSample: boolean;
  subtaskIndex: number | null;
  points: number | null;
}

interface EditBase {
  versionId: string;
  expectedEditSeq: number;
  actorId: string | null;
}

export async function addDraftTests(input: EditBase & { tests: readonly NewTest[] }): Promise<{ indexes: number[]; head: DraftHead }> {
  const store = getTestDataStore();
  const blobs: { input: string; output: string }[] = [];
  for (const t of input.tests) {
    blobs.push({
      input: (await ensureTestBlob(db, store, t.input)).sha256,
      output: (await ensureTestBlob(db, store, t.output)).sha256,
    });
  }
  return retryingTransaction(
    async (tx) => {
      const head = await touchDraft(tx, { ...input, kind: "judging" });
      const count = await tx.testCase.count({ where: { problemVersionId: input.versionId } });
      if (count + input.tests.length > IMPORT_LIMITS.tests) {
        throw new ValidationError(`A revision has at most ${IMPORT_LIMITS.tests} tests.`);
      }
      const rows = input.tests.map((t, i) => ({
        problemVersionId: input.versionId,
        index: count + i,
        isSample: t.isSample,
        subtaskIndex: t.subtaskIndex,
        points: t.points,
        inputSha256: blobs[i]!.input,
        outputSha256: blobs[i]!.output,
      }));
      await tx.testCase.createMany({ data: rows });
      return { indexes: rows.map((r) => r.index), head };
    },
    { timeout: 30_000 },
  );
}

export async function updateDraftTest(
  input: EditBase & { index: number; isSample: boolean; subtaskIndex: number | null; points: number | null },
): Promise<DraftHead> {
  return retryingTransaction(async (tx) => {
    const head = await touchDraft(tx, { ...input, kind: "judging" });
    const updated = await tx.testCase.updateMany({
      where: { problemVersionId: input.versionId, index: input.index },
      data: { isSample: input.isSample, subtaskIndex: input.subtaskIndex, points: input.points },
    });
    if (updated.count === 0) throw new NotFoundError(`Test ${input.index} does not exist.`);
    return head;
  });
}

/** Remove tests and renumber the rest 0..n-1 (ascending, so each target index is already free). */
export async function removeDraftTests(input: EditBase & { indexes: readonly number[] }): Promise<DraftHead> {
  return retryingTransaction(
    async (tx) => {
      const head = await touchDraft(tx, { ...input, kind: "judging" });
      const removed = await tx.testCase.deleteMany({ where: { problemVersionId: input.versionId, index: { in: [...input.indexes] } } });
      if (removed.count === 0) throw new NotFoundError("None of those tests exist.");
      const rest = await tx.testCase.findMany({
        where: { problemVersionId: input.versionId },
        orderBy: { index: "asc" },
        select: { id: true, index: true },
      });
      for (const [i, row] of rest.entries()) {
        if (row.index !== i) await tx.testCase.update({ where: { id: row.id }, data: { index: i } });
      }
      return head;
    },
    { timeout: 30_000 },
  );
}

export async function setDraftSubtasks(
  input: EditBase & {
    subtasks: ReadonlyArray<{ index: number; points: number; aggregation: SubtaskAggregation; dependsOn: readonly number[] }>;
  },
): Promise<DraftHead> {
  const indexes = input.subtasks.map((s) => s.index);
  if (new Set(indexes).size !== indexes.length) throw new ValidationError("Each subtask number may appear once.");
  return retryingTransaction(async (tx) => {
    const head = await touchDraft(tx, { ...input, kind: "judging" });
    await tx.subtask.deleteMany({ where: { problemVersionId: input.versionId } });
    if (input.subtasks.length > 0) {
      await tx.subtask.createMany({
        data: input.subtasks.map((s) => ({
          problemVersionId: input.versionId,
          index: s.index,
          points: s.points,
          aggregation: s.aggregation,
          dependsOn: [...new Set(s.dependsOn)].sort((a, b) => a - b),
        })),
      });
    }
    return head;
  });
}
