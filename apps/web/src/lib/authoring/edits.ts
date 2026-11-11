import "server-only";
import { Prisma, type ContentOrigin, type ScoringMode } from "@recx/db";
import { SQL_DIALECT, TESTLIB_ID, type CompareMode, type IoMode, type LanguageKey } from "@recx/shared";
import type { Difficulty, ReferenceExpectedVerdict } from "@recx/shared/authoring";
import { db } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { ensureTestBlob } from "@/lib/testdata/blobs";
import { getTestDataStore } from "@/lib/testdata/store";
import { touchDraft, type DraftHead } from "./draft";
import { effectiveCompareMode } from "./lifecycle";
import { retryingTransaction } from "./retry";

/**
 * Field edits of a DRAFT revision, each through touchDraft:
 *
 *   content   details (title, difficulty, statement, constraints, origin),
 *             starter code, hints and editorial — validation still counts
 *   judging   io / compare / scoring mode, signature, limits, checker,
 *             reference solutions — bumps judgeSeq (re-validate)
 */

interface EditBase {
  versionId: string;
  expectedEditSeq: number;
  actorId: string | null;
}

export async function updateDraftDetails(
  input: EditBase & { title: string; difficulty: Difficulty; statementMd: string; constraints: readonly string[]; origin: ContentOrigin },
): Promise<DraftHead> {
  return retryingTransaction(async (tx) => {
    const head = await touchDraft(tx, { ...input, kind: "content" });
    await tx.problemVersion.update({
      where: { id: input.versionId },
      data: {
        title: input.title,
        difficulty: input.difficulty,
        statementMd: input.statementMd,
        constraints: [...input.constraints],
        origin: input.origin,
      },
    });
    return head;
  });
}

export async function updateDraftJudging(
  input: EditBase & {
    ioMode: IoMode;
    functionSignature: Record<string, unknown> | null;
    compareMode: CompareMode;
    floatEpsilon: number | null;
    scoringMode: ScoringMode;
    stopOnFirstFailure: boolean;
    timeLimitMs: number;
    memoryLimitKb: number;
    /** SQL versions only (Phase 12k): is the row order part of the answer? */
    sqlOrdered?: boolean | null;
    /**
     * DEBUGGING problems (Phase 12m): the most lines a student may change
     * in the program they were given. Null for every other problem.
     */
    maxEditedLines?: number | null;
  },
): Promise<DraftHead> {
  const signature = input.ioMode === "FUNCTION" ? input.functionSignature : null;
  /**
   * Phase 12k. A SQL version's three facts are decided here rather than
   * asked for: it compares ROWS (the database's own CHECK says the same),
   * it is judged in the one dialect, and the ordering rule is the author's
   * answer to one question. Switching a version AWAY from SQL clears all
   * three, so a STDIN version can never be left carrying them — which is
   * the other half of the same CHECK.
   */
  const sql = input.ioMode === "SQL";
  const compareMode = sql ? "ROWS" : effectiveCompareMode(input.ioMode, input.compareMode, signature);
  /**
   * Phase 12l. An interactive version compares no output, so a float
   * tolerance on one would be a stored number that changes nothing (the
   * database says so too: ProblemVersion_interactive_no_epsilon), and it
   * is judged by its interactor rather than by a checker beside it.
   * Switching a version AWAY from INTERACTIVE drops the interactor, which
   * is the other half of the same mirror CHECK.
   */
  const interactive = compareMode === "INTERACTIVE";
  /**
   * Phase 12m. An edit budget belongs to a problem that has a program to
   * repair: a SQL problem's starter is a comment and a conversation is not
   * a program, so switching a version to either kind clears the budget
   * rather than leaving a number nothing can measure (the database says so
   * too: ProblemVersion_debug_budget_kind).
   */
  const answerOnly = input.ioMode === "OUTPUT_ONLY";
  const budget = sql || interactive || answerOnly ? null : (input.maxEditedLines ?? null);
  return retryingTransaction(async (tx) => {
    const head = await touchDraft(tx, { ...input, kind: "judging" });
    await tx.problemVersion.update({
      where: { id: input.versionId },
      data: {
        ioMode: input.ioMode,
        functionSignature: signature === null ? Prisma.DbNull : (signature as Prisma.InputJsonValue),
        compareMode,
        sqlDialect: sql ? SQL_DIALECT : null,
        sqlOrdered: sql ? (input.sqlOrdered ?? true) : null,
        // A SQL problem has no checker: the comparison is the result set.
        ...(sql ? { checkerSha256: null, testlibId: null } : {}),
        ...(interactive ? { checkerSha256: null } : { interactorSha256: null }),
        floatEpsilon: interactive ? null : input.floatEpsilon,
        maxEditedLines: budget,
        scoringMode: input.scoringMode,
        stopOnFirstFailure: input.stopOnFirstFailure,
        timeLimitMs: input.timeLimitMs,
        memoryLimitKb: input.memoryLimitKb,
      },
    });
    return head;
  });
}

/** Attach (or remove, with null) the testlib checker; the source is a content-addressed TestBlob. */
export async function setDraftChecker(input: EditBase & { source: string | null }): Promise<DraftHead> {
  const blob = input.source === null ? null : await ensureTestBlob(db, getTestDataStore(), Buffer.from(input.source, "utf8"));
  return retryingTransaction(async (tx) => {
    const head = await touchDraft(tx, { ...input, kind: "judging" });
    await tx.problemVersion.update({
      where: { id: input.versionId },
      data: { checkerSha256: blob?.sha256 ?? null, testlibId: blob ? TESTLIB_ID : null },
    });
    return head;
  });
}

/**
 * Attach (or remove, with null) the testlib INTERACTOR (Phase 12l).
 *
 * Its own edit rather than a field of the judging form, exactly like the
 * checker's: a source file is pasted and stored as a content-addressed
 * blob, and attaching one is a change to how the problem is JUDGED, so it
 * moves `judgeSeq` and invalidates the validation runs that came before.
 *
 * `testlibId` is shared with the checker because a version has one or the
 * other, never both — `compareMode` is a single value, and the database
 * refuses the pair (ProblemVersion_interactive_no_checker).
 */
export async function setDraftInteractor(input: EditBase & { source: string | null }): Promise<DraftHead> {
  const blob = input.source === null ? null : await ensureTestBlob(db, getTestDataStore(), Buffer.from(input.source, "utf8"));
  return retryingTransaction(async (tx) => {
    const head = await touchDraft(tx, { ...input, kind: "judging" });
    await tx.problemVersion.update({
      where: { id: input.versionId },
      data: { interactorSha256: blob?.sha256 ?? null, testlibId: blob ? TESTLIB_ID : null },
    });
    return head;
  });
}

export async function upsertReferenceSolution(
  input: EditBase & {
    referenceId?: string;
    /** A LanguageKey, or the SQL language (Phase 12k). */
    language: string;
    label: string;
    expectedVerdict: ReferenceExpectedVerdict;
    source: string;
  },
): Promise<{ referenceId: string; head: DraftHead }> {
  return retryingTransaction(async (tx) => {
    const head = await touchDraft(tx, { ...input, kind: "judging" });
    const data = { language: input.language, label: input.label, expectedVerdict: input.expectedVerdict, source: input.source };
    if (input.referenceId) {
      const updated = await tx.referenceSolution.updateMany({
        where: { id: input.referenceId, problemVersionId: input.versionId },
        data: { ...data, measuredMs: null },
      });
      if (updated.count === 0) throw new NotFoundError("That reference solution is not part of this revision.");
      return { referenceId: input.referenceId, head };
    }
    const created = await tx.referenceSolution.create({
      data: { problemVersionId: input.versionId, ...data },
      select: { id: true },
    });
    return { referenceId: created.id, head };
  });
}

/** Remove a reference solution (its draft validation runs go first: the foreign key restricts). */
export async function removeReferenceSolution(input: EditBase & { referenceId: string }): Promise<DraftHead> {
  return retryingTransaction(async (tx) => {
    const head = await touchDraft(tx, { ...input, kind: "judging" });
    const ref = await tx.referenceSolution.findFirst({
      where: { id: input.referenceId, problemVersionId: input.versionId },
      select: { id: true },
    });
    if (!ref) throw new NotFoundError("That reference solution is not part of this revision.");
    await tx.validationRun.deleteMany({ where: { referenceSolutionId: ref.id, problemVersionId: input.versionId } });
    await tx.referenceSolution.delete({ where: { id: ref.id } });
    return head;
  });
}

export async function upsertStarterCode(input: EditBase & { language: LanguageKey; code: string }): Promise<DraftHead> {
  return retryingTransaction(async (tx) => {
    const head = await touchDraft(tx, { ...input, kind: "content" });
    await tx.starterCode.upsert({
      where: { problemVersionId_language: { problemVersionId: input.versionId, language: input.language } },
      create: { problemVersionId: input.versionId, language: input.language, code: input.code },
      update: { code: input.code },
    });
    return head;
  });
}

export async function removeStarterCode(input: EditBase & { language: LanguageKey }): Promise<DraftHead> {
  return retryingTransaction(async (tx) => {
    const head = await touchDraft(tx, { ...input, kind: "content" });
    await tx.starterCode.deleteMany({ where: { problemVersionId: input.versionId, language: input.language } });
    return head;
  });
}

/**
 * Replace the tiered hints and the editorial. Hints are tiers 1..3 in
 * order; the first empty one ends the list. A null editorial removes it.
 */
export async function setDraftHelp(input: EditBase & { hints: readonly string[]; editorialMd: string | null }): Promise<DraftHead> {
  const hints: string[] = [];
  for (const h of input.hints) {
    if (h.trim().length === 0) break;
    hints.push(h);
  }
  const editorial = input.editorialMd !== null && input.editorialMd.trim().length > 0 ? input.editorialMd : null;
  return retryingTransaction(async (tx) => {
    const head = await touchDraft(tx, { ...input, kind: "content" });
    await tx.hint.deleteMany({ where: { problemVersionId: input.versionId } });
    if (hints.length > 0) {
      await tx.hint.createMany({ data: hints.map((contentMd, i) => ({ problemVersionId: input.versionId, tier: i + 1, contentMd })) });
    }
    if (editorial === null) await tx.editorial.deleteMany({ where: { problemVersionId: input.versionId } });
    else {
      await tx.editorial.upsert({
        where: { problemVersionId: input.versionId },
        create: { problemVersionId: input.versionId, contentMd: editorial },
        update: { contentMd: editorial },
      });
    }
    return head;
  });
}
