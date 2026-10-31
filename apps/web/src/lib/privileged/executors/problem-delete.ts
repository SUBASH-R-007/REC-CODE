import "server-only";
import type { DbTx } from "@recx/db";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { NotFoundError, ValidationError } from "@/lib/errors";
import type { Executor } from "@/lib/privileged/types";

/**
 * PROBLEM_DELETE / VERSION_DELETE. Only content no student ever saw can be
 * deleted: a revision that was never frozen (published) and is not live, or
 * a problem with no frozen revision and no student-linked rows. A frozen
 * revision is immutable (the ProblemVersion_frozen_guard trigger refuses
 * even a DELETE), so it is retired instead (super-problems#retireProblem).
 *
 * Each deletion is one transaction that removes the revision's children
 * explicitly. A foreign key from a table this list does not know about
 * fails the whole transaction, so nothing is ever partly deleted. Test
 * blobs and bundles are left in place (content-addressed and shared; see
 * docs/OPEN-QUESTIONS.md).
 */

export const RETIRE_INSTEAD =
  "This revision was published, so it is frozen and can never be deleted. Retire the problem instead.";

export interface DeletionCheck {
  label: string;
  blockers: string[];
}

async function versionBlockers(tx: DbTx, version: { id: string; frozenAt: Date | null }): Promise<string[]> {
  const blockers: string[] = [];
  if (version.frozenAt) blockers.push(RETIRE_INSTEAD);
  const [live, submissions, runs, reveals] = await Promise.all([
    tx.problem.count({ where: { liveVersionId: version.id } }),
    tx.submission.count({ where: { problemVersionId: version.id } }),
    tx.runRequest.count({ where: { problemVersionId: version.id } }),
    tx.hintReveal.count({ where: { hint: { problemVersionId: version.id } } }),
  ]);
  if (live > 0) blockers.push("This revision is the live version of its problem.");
  if (submissions > 0) blockers.push(`${submissions} submission(s) are pinned to this revision.`);
  if (runs > 0) blockers.push(`${runs} run request(s) used this revision.`);
  if (reveals > 0) blockers.push(`Students revealed hints of this revision (${reveals}).`);
  return blockers;
}

/** Why a revision cannot be deleted (no blockers = deletable). */
export async function versionDeletionCheck(tx: DbTx, problemVersionId: string): Promise<DeletionCheck> {
  const version = await tx.problemVersion.findUnique({
    where: { id: problemVersionId },
    select: {
      id: true,
      revision: true,
      frozenAt: true,
      problem: { select: { displayCode: true, title: true, _count: { select: { versions: true } } } },
    },
  });
  if (!version) throw new NotFoundError("That problem revision was not found.");
  const blockers = await versionBlockers(tx, version);
  if (version.problem._count.versions <= 1) {
    blockers.push("This is the only revision of the problem. Delete the problem instead.");
  }
  return { label: `${version.problem.displayCode} ${version.problem.title}, revision ${version.revision}`, blockers };
}

const STUDENT_LINK_NAMES = [
  "submissions",
  "run requests",
  "student progress rows",
  "hint reveals",
  "editorial views",
  "AI helper answers",
  "activity rows",
  "bookmarks",
  "notes",
  "code drafts",
  "study-plan items",
  "daily challenges",
] as const;

/** Why a problem cannot be deleted (no blockers = deletable). */
export async function problemDeletionCheck(tx: DbTx, problemId: string): Promise<DeletionCheck> {
  const problem = await tx.problem.findUnique({
    where: { id: problemId },
    select: { displayCode: true, title: true, liveVersionId: true, versions: { select: { frozenAt: true } } },
  });
  if (!problem) throw new NotFoundError("That problem was not found.");
  const blockers: string[] = [];
  if (problem.liveVersionId || problem.versions.some((v) => v.frozenAt)) {
    blockers.push("This problem has a published (frozen) revision, so it can never be deleted. Retire it instead.");
  }
  const where = { problemId };
  const counts = await Promise.all([
    tx.submission.count({ where }),
    tx.runRequest.count({ where: { problemVersion: { problemId } } }),
    tx.userProblemStatus.count({ where }),
    tx.hintReveal.count({ where }),
    tx.editorialView.count({ where }),
    tx.aiAssist.count({ where }),
    tx.problemActivity.count({ where }),
    tx.bookmark.count({ where }),
    tx.note.count({ where }),
    tx.codeDraft.count({ where }),
    tx.studyPlanItem.count({ where }),
    tx.dailyChallenge.count({ where }),
  ]);
  const linked = counts.flatMap((n, i) => (n > 0 ? [`${n} ${STUDENT_LINK_NAMES[i]}`] : []));
  if (linked.length > 0) blockers.push(`Students are linked to this problem: ${linked.join(", ")}.`);
  return { label: `${problem.displayCode} ${problem.title}`, blockers };
}

/** Remove one never-frozen revision and its children (inside the caller's transaction). */
async function deleteVersionRows(tx: DbTx, problemVersionId: string): Promise<void> {
  const where = { problemVersionId };
  await tx.validationRun.deleteMany({ where });
  await tx.hint.deleteMany({ where });
  await tx.editorial.deleteMany({ where });
  await tx.testCase.deleteMany({ where });
  await tx.starterCode.deleteMany({ where });
  await tx.referenceSolution.deleteMany({ where });
  await tx.subtask.deleteMany({ where });
  await tx.problemLanguageLimit.deleteMany({ where });
  await tx.problemReview.deleteMany({ where });
  await tx.problemVersion.delete({ where: { id: problemVersionId } });
}

export async function deleteDraftVersion(problemVersionId: string): Promise<{ problemId: string; revision: number }> {
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ problemId: string; revision: number }[]>`
      SELECT "problemId", revision FROM "ProblemVersion" WHERE id = ${problemVersionId} FOR UPDATE`;
    const row = locked[0];
    if (!row) throw new NotFoundError("That problem revision was not found.");
    await tx.$queryRaw`SELECT id FROM "Problem" WHERE id = ${row.problemId} FOR UPDATE`;
    const check = await versionDeletionCheck(tx, problemVersionId);
    if (check.blockers.length > 0) throw new ValidationError(check.blockers.join(" "));
    await deleteVersionRows(tx, problemVersionId);
    return row;
  });
}

export async function deleteUnpublishedProblem(problemId: string): Promise<{ versions: number; displayCode: string }> {
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ displayCode: string }[]>`
      SELECT "displayCode" FROM "Problem" WHERE id = ${problemId} FOR UPDATE`;
    const row = locked[0];
    if (!row) throw new NotFoundError("That problem was not found.");
    const check = await problemDeletionCheck(tx, problemId);
    if (check.blockers.length > 0) throw new ValidationError(check.blockers.join(" "));
    const versions = await tx.problemVersion.findMany({ where: { problemId }, select: { id: true } });
    for (const v of versions) await deleteVersionRows(tx, v.id);
    await tx.problem.delete({ where: { id: problemId } });
    return { versions: versions.length, displayCode: row.displayCode };
  });
}

export const executeProblemDelete: Executor<"PROBLEM_DELETE"> = async (op, actor) => {
  const done = await deleteUnpublishedProblem(op.payload.problemId);
  await audit({
    actorId: actor.id,
    action: "problem.deleted",
    entityType: "Problem",
    entityId: op.payload.problemId,
    sensitivity: "SENSITIVE",
    metadata: { operationId: op.id, displayCode: done.displayCode, versions: done.versions },
    ipHash: actor.ipHash,
  });
  return { result: { problemId: op.payload.problemId, displayCode: done.displayCode, versionsDeleted: done.versions } };
};

export const executeVersionDelete: Executor<"VERSION_DELETE"> = async (op, actor) => {
  const done = await deleteDraftVersion(op.payload.problemVersionId);
  await audit({
    actorId: actor.id,
    action: "problem.version_deleted",
    entityType: "ProblemVersion",
    entityId: op.payload.problemVersionId,
    sensitivity: "SENSITIVE",
    metadata: { operationId: op.id, problemId: done.problemId, revision: done.revision },
    ipHash: actor.ipHash,
  });
  return {
    result: { problemVersionId: op.payload.problemVersionId, problemId: done.problemId, revision: done.revision },
  };
};
