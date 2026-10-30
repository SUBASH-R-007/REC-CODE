import "server-only";
import { sqlResultSetSchema, type ResultRequest } from "@recx/shared";
import { db } from "@/lib/db";
import { ensureTestBlob } from "@/lib/testdata/blobs";
import { getTestDataStore } from "@/lib/testdata/store";

/**
 * Storing a capture run's result sets as a version's expected results
 * (Phase 12k).
 *
 * This is the only path that writes an expected result for a SQL problem,
 * and it is deliberately narrow:
 *
 *   - only a VALIDATION job, so a submission cannot send its own answer;
 *   - only a version whose io mode is SQL;
 *   - only a version that is not frozen (the database's own frozen guard
 *     refuses the rest, and this refuses it earlier with a reason);
 *   - only cases that already exist, by index, so a capture cannot invent
 *     one;
 *   - and only when the run reported a result for EVERY case, because a
 *     half-captured version would publish with one case's expected rows
 *     left over from a previous dataset.
 *
 * The rows themselves are a blob like any other test blob: content-
 * addressed, deduplicated, inline when small. Two cases with the same
 * expected result share one blob, which is how the empty placeholder a
 * draft starts with costs nothing.
 */

export type CaptureOutcome =
  | { stored: true; cases: number }
  | { stored: false; reason: string };

export async function storeSqlCapture(
  runId: string,
  body: Pick<ResultRequest, "kind" | "sqlCaptured">,
): Promise<CaptureOutcome> {
  if (!body.sqlCaptured || body.sqlCaptured.length === 0) return { stored: false, reason: "nothing to store" };
  if (body.kind !== "validation") return { stored: false, reason: "only a validation run captures expected results" };

  const run = await db.validationRun.findUnique({
    where: { id: runId },
    select: {
      problemVersion: {
        select: {
          id: true,
          ioMode: true,
          frozenAt: true,
          testCases: { orderBy: { index: "asc" }, select: { id: true, index: true } },
        },
      },
    },
  });
  const version = run?.problemVersion;
  if (!version) return { stored: false, reason: "the run disappeared" };
  if (version.ioMode !== "SQL") return { stored: false, reason: "that version is not a SQL problem" };
  if (version.frozenAt) return { stored: false, reason: "that version is published and frozen" };

  const byIndex = new Map(version.testCases.map((test) => [test.index, test.id]));
  const unknown = body.sqlCaptured.filter((entry) => !byIndex.has(entry.index)).map((entry) => entry.index);
  if (unknown.length > 0) {
    return { stored: false, reason: `the run reported cases this version does not have: ${unknown.join(", ")}` };
  }
  const missing = version.testCases.filter((test) => !body.sqlCaptured!.some((e) => e.index === test.index));
  if (missing.length > 0) {
    return {
      stored: false,
      reason: `no result was captured for case ${missing.map((m) => m.index).join(", ")}`,
    };
  }

  const store = getTestDataStore();
  const writes: Array<{ id: string; sha256: string }> = [];
  for (const entry of body.sqlCaptured) {
    // Parsed again here: the result route validated the shape, and this
    // validates it against the LIMITS a stored expected result must obey.
    const parsed = sqlResultSetSchema.safeParse(entry.resultSet);
    if (!parsed.success) {
      return { stored: false, reason: `case ${entry.index}: ${parsed.error.issues[0]?.message ?? "not a result set"}` };
    }
    // Canonical JSON: the key order is the schema's, so the same rows
    // always hash to the same blob.
    const bytes = Buffer.from(JSON.stringify({ columns: parsed.data.columns, rows: parsed.data.rows }), "utf8");
    const blob = await ensureTestBlob(db, store, bytes);
    writes.push({ id: byIndex.get(entry.index)!, sha256: blob.sha256 });
  }

  await db.$transaction(
    writes.map((write) => db.testCase.update({ where: { id: write.id }, data: { outputSha256: write.sha256 } })),
  );
  return { stored: true, cases: writes.length };
}
