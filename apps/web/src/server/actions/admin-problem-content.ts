"use server";

import { revalidatePath } from "next/cache";
import { requireActionRole } from "@/lib/auth/guards";
import { audit } from "@/lib/audit";
import type { DraftHead } from "@/lib/authoring/draft";
import {
  removeReferenceSolution as removeReference,
  removeStarterCode as removeStarter,
  setDraftChecker as setChecker,
  setDraftInteractor as setInteractor,
  setDraftHelp as setHelp,
  updateDraftDetails as updateDetails,
  updateDraftJudging as updateJudging,
  upsertReferenceSolution as upsertReference,
  upsertStarterCode as upsertStarter,
} from "@/lib/authoring/edits";
import {
  addTestsSchema,
  checkerSchema,
  interactorSchema,
  helpSchema,
  referenceSolutionSchema,
  removeReferenceSchema,
  removeStarterSchema,
  removeTestsSchema,
  starterSchema,
  subtasksSchema,
  updateDetailsSchema,
  updateJudgingSchema,
  updateTestSchema,
} from "@/lib/authoring/schemas";
import {
  addDraftTests as addTests,
  removeDraftTests as removeTests,
  setDraftSubtasks as setSubtasks,
  updateDraftTest as updateTest,
} from "@/lib/authoring/tests";
import { runAction, type ActionResult } from "@/lib/errors";
import { requestIpHash } from "@/lib/ip";

/**
 * Edits of a DRAFT revision's content. Every export: ADMIN or SUPER_ADMIN
 * (the guard is the first statement), zod-validated, carries the editSeq the
 * form was rendered with (optimistic concurrency: a stale form gets a
 * conflict), goes through touchDraft (src/lib/authoring/draft.ts) and is
 * audited as problem.draft.edited (NORMAL) with {versionId, section, editSeq}.
 *
 * "judging" sections (judging, checker, tests, subtasks, reference
 * solutions) bump judgeSeq, so validation must run again; "content"
 * sections (details, starter code, help) do not.
 */

const STAFF = ["ADMIN", "SUPER_ADMIN"] as const;

type Edited = { editSeq: number; judgeSeq: number };

async function edited(actorId: string, section: string, head: DraftHead, extra: Record<string, string | number | boolean> = {}): Promise<Edited> {
  await audit({
    actorId,
    action: "problem.draft.edited",
    entityType: "ProblemVersion",
    entityId: head.versionId,
    sensitivity: "NORMAL",
    metadata: { problemId: head.problemId, revision: head.revision, versionId: head.versionId, section, editSeq: head.editSeq, ...extra },
    ipHash: await requestIpHash(),
  });
  revalidatePath(`/admin/problems/${head.problemId}`);
  revalidatePath(`/admin/problems/${head.problemId}/testcases`);
  revalidatePath(`/admin/problems/${head.problemId}/validate`);
  return { editSeq: head.editSeq, judgeSeq: head.judgeSeq };
}

export async function updateDraftDetails(input: {
  versionId: string;
  expectedEditSeq: number;
  title: string;
  difficulty: string;
  statementMd: string;
  constraints: string[];
  origin: string;
}): Promise<ActionResult<Edited>> {
  return runAction(async () => {
    const actor = await requireActionRole(...STAFF);
    const data = updateDetailsSchema.parse(input);
    const head = await updateDetails({ ...data, actorId: actor.id });
    return edited(actor.id, "details", head);
  }, "updateDraftDetails");
}

export async function updateDraftJudging(input: {
  versionId: string;
  expectedEditSeq: number;
  ioMode: string;
  functionSignature: string;
  compareMode: string;
  floatEpsilon: number | string | null;
  scoringMode: string;
  stopOnFirstFailure: boolean;
  timeLimitMs: number | string;
  memoryLimitMb: number | string;
  /** DEBUGGING problems (Phase 12m); blank or null means "not one". */
  maxEditedLines?: number | string | null;
}): Promise<ActionResult<Edited>> {
  return runAction(async () => {
    const actor = await requireActionRole(...STAFF);
    const blank = (value: number | string | null | undefined) =>
      value === "" || value === null || value === undefined ? null : value;
    const data = updateJudgingSchema.parse({
      ...input,
      floatEpsilon: blank(input.floatEpsilon),
      maxEditedLines: blank(input.maxEditedLines),
    });
    const head = await updateJudging({
      versionId: data.versionId,
      expectedEditSeq: data.expectedEditSeq,
      actorId: actor.id,
      ioMode: data.ioMode,
      functionSignature: data.functionSignature,
      compareMode: data.compareMode,
      floatEpsilon: data.floatEpsilon,
      scoringMode: data.scoringMode,
      stopOnFirstFailure: data.stopOnFirstFailure,
      timeLimitMs: data.timeLimitMs,
      memoryLimitKb: data.memoryLimitMb * 1024,
      maxEditedLines: data.maxEditedLines,
      /**
       * Phase 12k's ordering rule, which this call did not forward: the
       * form asked the author whether the row order is part of the answer,
       * the schema validated it, and then the edit defaulted it to true.
       * An author who answered "no" had their answer reset, and the
       * question SPEC asks to be asked rather than guessed was guessed.
       */
      sqlOrdered: data.sqlOrdered,
    });
    return edited(actor.id, "judging", head);
  }, "updateDraftJudging");
}

export async function setDraftChecker(input: { versionId: string; expectedEditSeq: number; source: string | null }): Promise<ActionResult<Edited>> {
  return runAction(async () => {
    const actor = await requireActionRole(...STAFF);
    const data = checkerSchema.parse(input);
    const source = data.source !== null && data.source.trim().length > 0 ? data.source : null;
    const head = await setChecker({ versionId: data.versionId, expectedEditSeq: data.expectedEditSeq, actorId: actor.id, source });
    return edited(actor.id, "checker", head, { attached: source !== null });
  }, "setDraftChecker");
}

/**
 * Attach or remove the interactor of an interactive problem (Phase 12l).
 *
 * Its own action rather than a field of the judging form, exactly like the
 * checker's: it is a source file, it is stored as a content-addressed blob,
 * and attaching one changes how the problem is JUDGED — so it moves
 * `judgeSeq` and the validation runs that came before it stop counting.
 */
export async function setDraftInteractor(input: {
  versionId: string;
  expectedEditSeq: number;
  source: string | null;
}): Promise<ActionResult<Edited>> {
  return runAction(async () => {
    const actor = await requireActionRole(...STAFF);
    const data = interactorSchema.parse(input);
    const source = data.source !== null && data.source.trim().length > 0 ? data.source : null;
    const head = await setInteractor({ versionId: data.versionId, expectedEditSeq: data.expectedEditSeq, actorId: actor.id, source });
    return edited(actor.id, "interactor", head, { attached: source !== null });
  }, "setDraftInteractor");
}

export async function addDraftTests(input: {
  versionId: string;
  expectedEditSeq: number;
  tests: { input: string; output: string; isSample: boolean; subtaskIndex?: number | null; points?: number | null }[];
}): Promise<ActionResult<Edited & { indexes: number[] }>> {
  return runAction(async () => {
    const actor = await requireActionRole(...STAFF);
    const data = addTestsSchema.parse(input);
    const out = await addTests({
      versionId: data.versionId,
      expectedEditSeq: data.expectedEditSeq,
      actorId: actor.id,
      tests: data.tests.map((t) => ({
        input: Buffer.from(t.input, "utf8"),
        output: Buffer.from(t.output, "utf8"),
        isSample: t.isSample,
        subtaskIndex: t.subtaskIndex,
        points: t.points,
      })),
    });
    return { ...(await edited(actor.id, "tests", out.head, { added: out.indexes.length })), indexes: out.indexes };
  }, "addDraftTests");
}

export async function updateDraftTest(input: {
  versionId: string;
  expectedEditSeq: number;
  index: number;
  isSample: boolean;
  subtaskIndex: number | null;
  points: number | null;
}): Promise<ActionResult<Edited>> {
  return runAction(async () => {
    const actor = await requireActionRole(...STAFF);
    const data = updateTestSchema.parse(input);
    const head = await updateTest({ ...data, actorId: actor.id });
    return edited(actor.id, "tests", head, { index: data.index });
  }, "updateDraftTest");
}

export async function removeDraftTests(input: { versionId: string; expectedEditSeq: number; indexes: number[] }): Promise<ActionResult<Edited>> {
  return runAction(async () => {
    const actor = await requireActionRole(...STAFF);
    const data = removeTestsSchema.parse(input);
    const head = await removeTests({ ...data, actorId: actor.id });
    return edited(actor.id, "tests", head, { removed: data.indexes.length });
  }, "removeDraftTests");
}

export async function setDraftSubtasks(input: {
  versionId: string;
  expectedEditSeq: number;
  subtasks: { index: number; points: number; aggregation?: string; dependsOn?: number[] }[];
}): Promise<ActionResult<Edited>> {
  return runAction(async () => {
    const actor = await requireActionRole(...STAFF);
    const data = subtasksSchema.parse(input);
    const head = await setSubtasks({ ...data, actorId: actor.id });
    return edited(actor.id, "subtasks", head, { subtasks: data.subtasks.length });
  }, "setDraftSubtasks");
}

export async function upsertReferenceSolution(input: {
  versionId: string;
  expectedEditSeq: number;
  referenceId?: string;
  language: string;
  label: string;
  expectedVerdict: string;
  source: string;
}): Promise<ActionResult<Edited & { referenceId: string }>> {
  return runAction(async () => {
    const actor = await requireActionRole(...STAFF);
    const data = referenceSolutionSchema.parse(input);
    const out = await upsertReference({ ...data, actorId: actor.id });
    const meta = { referenceId: out.referenceId, language: data.language, expectedVerdict: data.expectedVerdict };
    return { ...(await edited(actor.id, "reference_solutions", out.head, meta)), referenceId: out.referenceId };
  }, "upsertReferenceSolution");
}

export async function removeReferenceSolution(input: { versionId: string; expectedEditSeq: number; referenceId: string }): Promise<ActionResult<Edited>> {
  return runAction(async () => {
    const actor = await requireActionRole(...STAFF);
    const data = removeReferenceSchema.parse(input);
    const head = await removeReference({ ...data, actorId: actor.id });
    return edited(actor.id, "reference_solutions", head, { removedReferenceId: data.referenceId });
  }, "removeReferenceSolution");
}

export async function upsertStarterCode(input: { versionId: string; expectedEditSeq: number; language: string; code: string }): Promise<ActionResult<Edited>> {
  return runAction(async () => {
    const actor = await requireActionRole(...STAFF);
    const data = starterSchema.parse(input);
    const head = await upsertStarter({ ...data, actorId: actor.id });
    return edited(actor.id, "starter_code", head, { language: data.language });
  }, "upsertStarterCode");
}

export async function removeStarterCode(input: { versionId: string; expectedEditSeq: number; language: string }): Promise<ActionResult<Edited>> {
  return runAction(async () => {
    const actor = await requireActionRole(...STAFF);
    const data = removeStarterSchema.parse(input);
    const head = await removeStarter({ ...data, actorId: actor.id });
    return edited(actor.id, "starter_code", head, { removedLanguage: data.language });
  }, "removeStarterCode");
}

export async function setDraftHelp(input: {
  versionId: string;
  expectedEditSeq: number;
  hints: string[];
  editorialMd: string | null;
}): Promise<ActionResult<Edited>> {
  return runAction(async () => {
    const actor = await requireActionRole(...STAFF);
    const data = helpSchema.parse(input);
    const head = await setHelp({ ...data, actorId: actor.id });
    return edited(actor.id, "help", head);
  }, "setDraftHelp");
}
