import "server-only";
import { createHash } from "node:crypto";
import {
  APTITUDE_CSV_SHAPE,
  APTITUDE_IMPORT_LIMITS,
  aptitudeDisplayCode,
  csvByteLength,
  normaliseQuestionForHash,
  parseCsvRecords,
  passageGroups,
  planImport,
  rowToQuestion,
  wordCountOf,
  type AptitudeArea,
  type AptitudeTopic,
  type ExistingQuestion,
  type PlannedRow,
  type ReadRow,
  type RowDefaults,
} from "@recx/shared";
import { db } from "@/lib/db";
import { APTITUDE_IDENTITY_SELECT } from "@/server/queries/aptitude-select";

/**
 * Applying an aptitude CSV (Phase 7d).
 *
 * SPEC §5: *so one bad row cannot discard a 300-question file.* That sentence
 * decides the shape of this module in three ways:
 *
 *   1. the plan is computed BEFORE anything is written (`planImport`), so a
 *      row that cannot be applied is a reported row rather than a failed
 *      transaction;
 *   2. each row is applied in its OWN transaction. One bad row rolls back
 *      itself and nothing else — which is the only way the sentence can be
 *      true, and the reason this is not one big transaction;
 *   3. an `AptitudeImportRow` is written for every line, applied or not, with
 *      every reason. The counters live on the parent and the reasons on the
 *      rows, exactly as `ProblemImport` does it.
 *
 * Display codes come from a Postgres SEQUENCE. `max(displayCode) + 1` would
 * hand the same code to two concurrent imports and the unique index would
 * refuse the second, failing a whole file for a reason unrelated to its
 * contents.
 */

export interface ImportOutcome {
  readonly importId: string;
  readonly status: "DONE" | "FAILED";
  readonly total: number;
  readonly created: number;
  readonly revised: number;
  readonly unchanged: number;
  readonly failed: number;
  /** Whole-file failure, if any. */
  readonly error: string | null;
}

export async function runAptitudeImport(args: {
  readonly text: string;
  readonly fileName: string;
  readonly uploadedById: string;
  readonly via: string;
  readonly defaultArea: AptitudeArea | null;
  readonly defaultTopic: AptitudeTopic | null;
  readonly sourceBatch: string | null;
}): Promise<ImportOutcome> {
  const fileSha256 = createHash("sha256").update(args.text).digest("hex");
  const sizeBytes = csvByteLength(args.text);

  /**
   * ONE clock for both ends of the import.
   *
   * `startedAt` has a database default and `finishedAt` is written by the
   * app, so leaving the default in place compares two clocks —
   * `AptitudeImport_finished_check` refused the first draft because the WSL
   * database clock runs ~200ms ahead of the host, and in production the app
   * and the database are different machines. Writing both from here is the
   * durable fix, and it is also the clock that measures the import's own
   * duration.
   */
  const startedAt = new Date();

  const record = await db.aptitudeImport.create({
    data: {
      uploadedById: args.uploadedById,
      fileName: args.fileName,
      sizeBytes: BigInt(sizeBytes),
      fileSha256,
      via: args.via,
      defaultArea: args.defaultArea,
      defaultTopic: args.defaultTopic,
      startedAt,
    },
    select: { id: true },
  });

  const fail = async (error: string): Promise<ImportOutcome> => {
    await db.aptitudeImport.update({
      where: { id: record.id },
      data: { status: "FAILED", error, finishedAt: finishedNow(startedAt) },
    });
    return {
      importId: record.id,
      status: "FAILED",
      total: 0,
      created: 0,
      revised: 0,
      unchanged: 0,
      failed: 0,
      error,
    };
  };

  const parsed = parseCsvRecords(args.text, APTITUDE_CSV_SHAPE);
  if (parsed.errors.length > 0) {
    // A file-level problem — the header, a cap, malformed quoting — means
    // nothing in the file is trusted, so nothing is imported. Every reason is
    // reported, with line numbers, rather than the first.
    return fail(
      parsed.errors
        .map((issue) => (issue.line > 0 ? `Line ${issue.line}: ${issue.message}` : issue.message))
        .join(" "),
    );
  }
  if (parsed.rows.length === 0) return fail("The file has a header and no question rows.");

  const defaults: RowDefaults = {
    area: args.defaultArea,
    topic: args.defaultTopic,
    origin: "FACULTY",
    sourceBatch: args.sourceBatch,
  };

  const read: ReadRow[] = parsed.rows.map((row) => {
    const result = rowToQuestion(row.cells, defaults);
    if (!result.ok) return { line: row.line, ok: false, errors: result.errors, warnings: result.warnings };
    return {
      line: row.line,
      ok: true,
      question: result.question,
      code: result.code,
      contentHash: createHash("sha256").update(normaliseQuestionForHash(result.question)).digest("hex"),
      passage: result.passage,
      warnings: result.warnings,
    };
  });

  const plan = planImport(read, await existingFor(read));
  const groups = passageGroups(plan.rows);

  // A passage group that is short is refused as a ROW problem, not a file
  // problem: the rest of the file still imports.
  const groupErrors = new Map<number, string>();
  for (const issue of groups.errors) groupErrors.set(issue.line, issue.message);

  // One passage row per distinct text, created up front so every question of
  // a group points at the same one.
  const passageIdByBody = new Map<string, string>();
  for (const group of groups.groups) {
    const first = plan.rows.find((row) => row.line === group.lines[0]!);
    const question = first?.question;
    if (!question) continue;
    /**
     * Stored as authored and sanitised at RENDER, which is how every other
     * markdown field in this product works (`ProblemVersion.statementMd`
     * through `renderMarkdown`). Sanitising on the way in would silently
     * rewrite a faculty member's text and leave the stored row disagreeing
     * with the file they uploaded.
     */
    const body = group.passage.body;
    const created = await db.aptitudePassage.create({
      data: {
        area: question.area,
        topic: question.topic,
        title: group.passage.title.slice(0, 200),
        body,
        wordCount: wordCountOf(body),
        sourceNote: `Imported from ${args.fileName} on ${new Date().toISOString().slice(0, 10)}.`,
        origin: question.origin,
        authorId: args.uploadedById,
      },
      select: { id: true },
    });
    passageIdByBody.set(group.passage.body, created.id);
  }

  let created = 0;
  let revised = 0;
  let unchanged = 0;
  let failed = 0;

  for (const row of plan.rows) {
    const groupProblem = groupErrors.get(row.line);
    const effective: PlannedRow =
      groupProblem && row.status !== "FAILED"
        ? { ...row, status: "FAILED", question: null, errors: [...row.errors, groupProblem] }
        : row;

    try {
      const applied = await applyRow(db, {
        importId: record.id,
        row: effective,
        passageIdByBody,
        authorId: args.uploadedById,
      });
      if (applied === "CREATED") created++;
      else if (applied === "NEW_REVISION") revised++;
      else if (applied === "UNCHANGED") unchanged++;
      else failed++;
    } catch (error) {
      // The row's own transaction rolled back; the file carries on. The
      // message is recorded so an operator is not left guessing which line
      // and why — which is the whole difference between this and one big
      // transaction.
      failed++;
      await db.aptitudeImportRow.create({
        data: {
          importId: record.id,
          line: effective.line,
          status: "FAILED",
          errors: [
            {
              path: "row",
              message: `The database refused this row: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
            },
          ],
          warnings: effective.warnings.map((message) => ({ path: "row", message })),
        },
      });
    }
  }

  await db.aptitudeImport.update({
    where: { id: record.id },
    data: {
      status: "DONE",
      total: plan.total,
      created,
      revised,
      unchanged,
      failed,
      finishedAt: finishedNow(startedAt),
    },
  });

  return {
    importId: record.id,
    status: "DONE",
    total: plan.total,
    created,
    revised,
    unchanged,
    failed,
    error: null,
  };
}

/** The questions this file might be about: by code, and by content hash. */
async function existingFor(read: readonly ReadRow[]): Promise<ExistingQuestion[]> {
  const codes = read.flatMap((row) => (row.ok && row.code !== null ? [row.code] : []));
  const hashes = read.flatMap((row) => (row.ok ? [row.contentHash] : []));
  if (codes.length === 0 && hashes.length === 0) return [];
  // Bounded by the file: never a scan of the whole bank.
  return db.aptitudeQuestion.findMany({
    where: { OR: [{ displayCode: { in: codes } }, { contentHash: { in: hashes } }] },
    select: APTITUDE_IDENTITY_SELECT,
  });
}

type AppliedStatus = "CREATED" | "NEW_REVISION" | "UNCHANGED" | "FAILED";

/**
 * Apply one row, in its own transaction.
 *
 * The `AptitudeImportRow` is written inside it, so a row and its result land
 * together or not at all — an import whose rows disagree with its questions
 * is an import nobody can audit.
 */
async function applyRow(
  client: typeof db,
  args: {
    readonly importId: string;
    readonly row: PlannedRow;
    readonly passageIdByBody: Map<string, string>;
    readonly authorId: string;
  },
): Promise<AppliedStatus> {
  const { row } = args;
  return client.$transaction(async (tx) => {
    const warnings = row.warnings.map((message) => ({ path: "row", message }));

    if (row.status === "FAILED" || row.question === null || row.contentHash === null) {
      await tx.aptitudeImportRow.create({
        data: {
          importId: args.importId,
          line: row.line,
          status: "FAILED",
          questionId: row.questionId,
          displayCode: row.displayCode,
          errors: row.errors.map((message) => ({ path: "row", message })),
          warnings,
        },
      });
      return "FAILED";
    }

    if (row.status === "UNCHANGED") {
      await tx.aptitudeImportRow.create({
        data: {
          importId: args.importId,
          line: row.line,
          status: "UNCHANGED",
          questionId: row.questionId,
          displayCode: row.displayCode,
          contentHash: row.contentHash,
          warnings,
        },
      });
      return "UNCHANGED";
    }

    const passageId = row.passage === null ? null : (args.passageIdByBody.get(row.passage.body) ?? null);
    const data = {
      area: row.question.area,
      topic: row.question.topic,
      kind: row.question.kind,
      difficulty: row.question.difficulty,
      passageId,
      // Stored as authored; `renderMarkdown` sanitises on the way out.
      stem: row.question.stem,
      options: [...row.question.options],
      correctOptionIndexes: [...row.question.correctOptionIndexes],
      numericAnswer: row.question.numericAnswer,
      numericTolerance: row.question.numericTolerance,
      numericUnit: row.question.numericUnit,
      explanation: row.question.explanation,
      expectedSeconds: row.question.expectedSeconds,
      origin: row.question.origin,
      sourceBatch: row.question.sourceBatch,
      contentHash: row.contentHash,
    };

    if (row.status === "NEW_REVISION" && row.questionId !== null) {
      const updated = await tx.aptitudeQuestion.update({
        where: { id: row.questionId },
        data,
        select: { id: true, displayCode: true },
      });
      await tx.aptitudeImportRow.create({
        data: {
          importId: args.importId,
          line: row.line,
          status: "NEW_REVISION",
          questionId: updated.id,
          displayCode: updated.displayCode,
          contentHash: row.contentHash,
          warnings,
        },
      });
      return "NEW_REVISION";
    }

    const displayCode = row.displayCode ?? (await nextDisplayCode(tx));
    const inserted = await tx.aptitudeQuestion.create({
      data: { ...data, displayCode, authorId: args.authorId },
      select: { id: true, displayCode: true },
    });
    await tx.aptitudeImportRow.create({
      data: {
        importId: args.importId,
        line: row.line,
        status: "CREATED",
        questionId: inserted.id,
        displayCode: inserted.displayCode,
        contentHash: row.contentHash,
        warnings,
      },
    });
    return "CREATED";
  });
}

/** The next display code, from the sequence. Race-free by construction. */
async function nextDisplayCode(tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]): Promise<string> {
  const [row] = await tx.$queryRawUnsafe<Array<{ next: bigint }>>(
    `SELECT nextval('public.aptitude_display_code_seq') AS next`,
  );
  return aptitudeDisplayCode(Number(row!.next));
}

/**
 * Now, but never before the import started.
 *
 * A clock that steps backwards mid-import (an NTP correction, a suspended
 * laptop) would otherwise produce a row the CHECK refuses — and losing the
 * whole import report to a clock adjustment would be absurd.
 */
function finishedNow(startedAt: Date): Date {
  const now = new Date();
  return now >= startedAt ? now : startedAt;
}

/** The limits a route handler checks before it reads a body. */
export const APTITUDE_UPLOAD_LIMITS = APTITUDE_IMPORT_LIMITS;
