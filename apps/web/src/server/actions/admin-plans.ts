"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { Prisma, type DbTx, type StudyPlanKind } from "@recx/db";
import { audit } from "@/lib/audit";
import { requireAdminScopeAction } from "@/lib/auth/scope";
import { db } from "@/lib/db";
import { ConflictError, NotFoundError, ValidationError, runAction, type ActionResult } from "@/lib/errors";
import { requestIpHash } from "@/lib/ip";
import { recountStudyPlan } from "@/lib/plans/recount";
import { PLAN_KINDS } from "@/components/plans/kinds";

/**
 * /admin/sheets and /admin/tracks mutations (StudyPlan kind SHEET / TRACK).
 * Plans are college-wide content, so these need no student scope; every one
 * is ADMIN / SUPER_ADMIN and audited (NORMAL, entityType StudyPlan).
 *
 * Every write runs in a transaction that first locks the plan row and
 * refuses while the plan is seed-managed (the seed would overwrite the edit:
 * detach it first). The kind always comes from the row. There is no delete —
 * unpublish instead, because deleting a plan would delete students'
 * enrolments — and the slug never changes after creation. Item changes
 * recount the plan and every enrolment (lib/plans/recount.ts).
 */

const ADMIN_PATH: Record<StudyPlanKind, string> = { SHEET: "/admin/sheets", TRACK: "/admin/tracks" };

const idSchema = z.string().trim().min(1).max(64);
const titleSchema = z.string().trim().min(3, "The title needs at least 3 characters.").max(120, "Keep the title under 120 characters.");
const descriptionSchema = z
  .string()
  .trim()
  .min(10, "The description needs at least 10 characters.")
  .max(2000, "Keep the description under 2,000 characters.");
const sortOrderSchema = z.coerce.number().int("The order must be a whole number.").min(0).max(10_000);
const sectionTitleSchema = z.string().trim().min(1, "Give the section a title.").max(120, "Keep the section title under 120 characters.");
const reasonSchema = z
  .string()
  .trim()
  .min(5, "Give a reason of at least 5 characters — it is recorded in the audit log.")
  .max(500, "Keep the reason under 500 characters.");
/** Lower-case, URL-safe and permanent (narrower than isPlanSlug, which also reads old mixed-case links). */
const slugSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{2,79}$/, "Use 3–80 lower-case letters, digits and hyphens, starting with a letter or digit.");

interface LockedPlan {
  id: string;
  slug: string;
  kind: StudyPlanKind;
  seedManaged: boolean;
  published: boolean;
}

/** Lock the plan row for this transaction and refuse while it is seed-managed. */
async function lockPlan(tx: DbTx, planId: string, opts: { allowSeedManaged?: boolean } = {}): Promise<LockedPlan> {
  const rows = await tx.$queryRaw<LockedPlan[]>`
    SELECT id, slug, kind::text AS kind, "seedManaged", published
    FROM "StudyPlan" WHERE id = ${planId} FOR UPDATE`;
  const plan = rows[0];
  if (!plan) throw new NotFoundError("That study plan was not found.");
  if (plan.seedManaged && !opts.allowSeedManaged) {
    throw new ConflictError("This plan is managed by the seed. Detach it from the seed first, then edit it.");
  }
  return plan;
}

async function lockSection(tx: DbTx, sectionId: string): Promise<{ plan: LockedPlan; sectionId: string; sortOrder: number }> {
  const section = await tx.studyPlanSection.findUnique({ where: { id: sectionId }, select: { id: true, planId: true } });
  if (!section) throw new NotFoundError("That section was not found.");
  const plan = await lockPlan(tx, section.planId);
  const fresh = await tx.studyPlanSection.findUnique({ where: { id: sectionId }, select: { sortOrder: true, planId: true } });
  if (!fresh || fresh.planId !== plan.id) throw new NotFoundError("That section was not found.");
  return { plan, sectionId, sortOrder: fresh.sortOrder };
}

function revalidatePlan(plan: Pick<LockedPlan, "id" | "kind" | "slug">) {
  revalidatePath(ADMIN_PATH[plan.kind]);
  revalidatePath(`${ADMIN_PATH[plan.kind]}/${plan.id}`);
  revalidatePath(PLAN_KINDS[plan.kind].basePath);
  revalidatePath(`${PLAN_KINDS[plan.kind].basePath}/${plan.slug}`);
}

async function touch(tx: DbTx, planId: string, actorId: string) {
  await tx.studyPlan.update({ where: { id: planId }, data: { updatedById: actorId } });
}

async function record(actorId: string, action: string, planId: string, metadata: Prisma.InputJsonObject) {
  await audit({
    actorId,
    action,
    entityType: "StudyPlan",
    entityId: planId,
    sensitivity: "NORMAL",
    metadata,
    ipHash: await requestIpHash(),
  });
}

/** Renumber a section's items 0..n-1 in their current order. */
async function renumberItems(tx: DbTx, sectionId: string) {
  const items = await tx.studyPlanItem.findMany({
    where: { sectionId },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    select: { id: true, sortOrder: true },
  });
  for (const [i, item] of items.entries()) {
    if (item.sortOrder !== i) await tx.studyPlanItem.update({ where: { id: item.id }, data: { sortOrder: i } });
  }
}

async function renumberSections(tx: DbTx, planId: string) {
  const sections = await tx.studyPlanSection.findMany({
    where: { planId },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    select: { id: true, sortOrder: true },
  });
  for (const [i, s] of sections.entries()) {
    if (s.sortOrder !== i) await tx.studyPlanSection.update({ where: { id: s.id }, data: { sortOrder: i } });
  }
}

// ── Plans ──────────────────────────────────────────────────────────────

const createSchema = z.object({
  kind: z.enum(["SHEET", "TRACK"]),
  slug: slugSchema,
  title: titleSchema,
  description: descriptionSchema,
  sortOrder: sortOrderSchema,
});
export type CreateStudyPlanInput = z.input<typeof createSchema>;

/** Create an unpublished, admin-managed plan and open its editor. */
export async function createStudyPlan(input: CreateStudyPlanInput): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const { user } = await requireAdminScopeAction();
    const parsed = createSchema.parse(input);
    let id: string;
    try {
      const created = await db.studyPlan.create({
        data: {
          slug: parsed.slug,
          kind: parsed.kind,
          title: parsed.title,
          description: parsed.description,
          sortOrder: parsed.sortOrder,
          published: false,
          seedManaged: false,
          createdById: user.id,
          updatedById: user.id,
        },
        select: { id: true },
      });
      id = created.id;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ValidationError("That slug is already used by another plan. Choose another.");
      }
      throw error;
    }
    await record(user.id, "plan.created", id, { kind: parsed.kind, slug: parsed.slug });
    revalidatePath(ADMIN_PATH[parsed.kind]);
    redirect(`${ADMIN_PATH[parsed.kind]}/${id}`);
  }, "createStudyPlan");
}

const updateSchema = z.object({
  planId: idSchema,
  title: titleSchema,
  description: descriptionSchema,
  sortOrder: sortOrderSchema,
});
export type UpdateStudyPlanInput = z.input<typeof updateSchema>;

export async function updateStudyPlan(input: UpdateStudyPlanInput): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const { user } = await requireAdminScopeAction();
    const parsed = updateSchema.parse(input);
    const plan = await db.$transaction(async (tx) => {
      const locked = await lockPlan(tx, parsed.planId);
      await tx.studyPlan.update({
        where: { id: locked.id },
        data: { title: parsed.title, description: parsed.description, sortOrder: parsed.sortOrder, updatedById: user.id },
      });
      return locked;
    });
    await record(user.id, "plan.updated", plan.id, { kind: plan.kind, slug: plan.slug });
    revalidatePlan(plan);
    return { id: plan.id };
  }, "updateStudyPlan");
}

const publishSchema = z.object({ planId: idSchema, published: z.boolean() });
export type SetStudyPlanPublishedInput = z.input<typeof publishSchema>;

export async function setStudyPlanPublished(input: SetStudyPlanPublishedInput): Promise<ActionResult<{ published: boolean }>> {
  return runAction(async () => {
    const { user } = await requireAdminScopeAction();
    const parsed = publishSchema.parse(input);
    const plan = await db.$transaction(async (tx) => {
      const locked = await lockPlan(tx, parsed.planId);
      if (locked.published === parsed.published) {
        throw new ValidationError(parsed.published ? "This plan is already published." : "This plan is already unpublished.");
      }
      if (parsed.published) {
        const { itemsTotal } = await recountStudyPlan(tx, locked.id);
        if (itemsTotal === 0) throw new ValidationError("Add at least one problem before publishing.");
      }
      await tx.studyPlan.update({ where: { id: locked.id }, data: { published: parsed.published, updatedById: user.id } });
      return locked;
    });
    await record(user.id, parsed.published ? "plan.published" : "plan.unpublished", plan.id, {
      kind: plan.kind,
      slug: plan.slug,
    });
    revalidatePlan(plan);
    return { published: parsed.published };
  }, "setStudyPlanPublished");
}

const detachSchema = z.object({ planId: idSchema, reason: reasonSchema });
export type DetachPlanFromSeedInput = z.input<typeof detachSchema>;

/** Hand a seeded plan over to /admin: the seed sync leaves it alone from now on. */
export async function detachPlanFromSeed(input: DetachPlanFromSeedInput): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const { user } = await requireAdminScopeAction();
    const parsed = detachSchema.parse(input);
    const plan = await db.$transaction(async (tx) => {
      const locked = await lockPlan(tx, parsed.planId, { allowSeedManaged: true });
      if (!locked.seedManaged) throw new ValidationError("This plan is not managed by the seed.");
      await tx.studyPlan.update({ where: { id: locked.id }, data: { seedManaged: false, updatedById: user.id } });
      return locked;
    });
    await record(user.id, "plan.detached_from_seed", plan.id, { kind: plan.kind, slug: plan.slug, reason: parsed.reason });
    revalidatePlan(plan);
    return { id: plan.id };
  }, "detachPlanFromSeed");
}

// ── Sections ───────────────────────────────────────────────────────────

const addSectionSchema = z.object({ planId: idSchema, title: sectionTitleSchema });
export type AddPlanSectionInput = z.input<typeof addSectionSchema>;

export async function addPlanSection(input: AddPlanSectionInput): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const { user } = await requireAdminScopeAction();
    const parsed = addSectionSchema.parse(input);
    const out = await db.$transaction(async (tx) => {
      const plan = await lockPlan(tx, parsed.planId);
      const last = await tx.studyPlanSection.findFirst({
        where: { planId: plan.id },
        orderBy: { sortOrder: "desc" },
        select: { sortOrder: true },
      });
      const section = await tx.studyPlanSection.create({
        data: { planId: plan.id, title: parsed.title, sortOrder: (last?.sortOrder ?? -1) + 1 },
        select: { id: true },
      });
      await touch(tx, plan.id, user.id);
      return { plan, sectionId: section.id };
    });
    await record(user.id, "plan.section.added", out.plan.id, { sectionId: out.sectionId, title: parsed.title });
    revalidatePlan(out.plan);
    return { id: out.sectionId };
  }, "addPlanSection");
}

const renameSectionSchema = z.object({ sectionId: idSchema, title: sectionTitleSchema });
export type RenamePlanSectionInput = z.input<typeof renameSectionSchema>;

export async function renamePlanSection(input: RenamePlanSectionInput): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const { user } = await requireAdminScopeAction();
    const parsed = renameSectionSchema.parse(input);
    const plan = await db.$transaction(async (tx) => {
      const locked = await lockSection(tx, parsed.sectionId);
      await tx.studyPlanSection.update({ where: { id: parsed.sectionId }, data: { title: parsed.title } });
      await touch(tx, locked.plan.id, user.id);
      return locked.plan;
    });
    await record(user.id, "plan.section.renamed", plan.id, { sectionId: parsed.sectionId, title: parsed.title });
    revalidatePlan(plan);
    return { id: parsed.sectionId };
  }, "renamePlanSection");
}

const moveSectionSchema = z.object({ sectionId: idSchema, direction: z.enum(["up", "down"]) });
export type MovePlanSectionInput = z.input<typeof moveSectionSchema>;

export async function movePlanSection(input: MovePlanSectionInput): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const { user } = await requireAdminScopeAction();
    const parsed = moveSectionSchema.parse(input);
    const plan = await db.$transaction(async (tx) => {
      const locked = await lockSection(tx, parsed.sectionId);
      await renumberSections(tx, locked.plan.id);
      const sections = await tx.studyPlanSection.findMany({
        where: { planId: locked.plan.id },
        orderBy: { sortOrder: "asc" },
        select: { id: true, sortOrder: true },
      });
      const at = sections.findIndex((s) => s.id === parsed.sectionId);
      const swap = parsed.direction === "up" ? at - 1 : at + 1;
      const other = sections[swap];
      const self = sections[at];
      if (!other || !self) throw new ValidationError(`This section is already ${parsed.direction === "up" ? "first" : "last"}.`);
      await tx.studyPlanSection.update({ where: { id: self.id }, data: { sortOrder: other.sortOrder } });
      await tx.studyPlanSection.update({ where: { id: other.id }, data: { sortOrder: self.sortOrder } });
      await touch(tx, locked.plan.id, user.id);
      return locked.plan;
    });
    await record(user.id, "plan.section.moved", plan.id, { sectionId: parsed.sectionId, direction: parsed.direction });
    revalidatePlan(plan);
    return { id: parsed.sectionId };
  }, "movePlanSection");
}

const sectionIdSchema = z.object({ sectionId: idSchema });
export type DeletePlanSectionInput = z.input<typeof sectionIdSchema>;

/** Delete a section and its items, then recount the plan and its enrolments. */
export async function deletePlanSection(input: DeletePlanSectionInput): Promise<ActionResult<{ itemsTotal: number }>> {
  return runAction(async () => {
    const { user } = await requireAdminScopeAction();
    const parsed = sectionIdSchema.parse(input);
    const out = await db.$transaction(async (tx) => {
      const locked = await lockSection(tx, parsed.sectionId);
      const removed = await tx.studyPlanItem.count({ where: { sectionId: parsed.sectionId } });
      await tx.studyPlanSection.delete({ where: { id: parsed.sectionId } });
      await renumberSections(tx, locked.plan.id);
      const { itemsTotal } = await recountStudyPlan(tx, locked.plan.id);
      if (itemsTotal === 0 && locked.plan.published) {
        await tx.studyPlan.update({ where: { id: locked.plan.id }, data: { published: false } });
      }
      await touch(tx, locked.plan.id, user.id);
      return { plan: locked.plan, itemsTotal, removed };
    });
    await record(user.id, "plan.section.deleted", out.plan.id, {
      sectionId: parsed.sectionId,
      itemsRemoved: out.removed,
      itemsTotal: out.itemsTotal,
    });
    revalidatePlan(out.plan);
    return { itemsTotal: out.itemsTotal };
  }, "deletePlanSection");
}

// ── Items ──────────────────────────────────────────────────────────────

const PROBLEM_CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

const addItemsSchema = z.object({
  planId: idSchema,
  sectionId: idSchema,
  problemCodes: z
    .array(z.string().trim().regex(PROBLEM_CODE, "A problem code may contain only letters, digits, '-' and '_'."))
    .min(1, "Enter at least one problem code.")
    .max(50, "Add at most 50 problems at a time."),
});
export type AddPlanItemsInput = z.input<typeof addItemsSchema>;

export interface AddPlanItemsResult {
  added: string[];
  alreadyInPlan: string[];
  unavailable: string[];
  itemsTotal: number;
}

/**
 * Add published problems (by display code) to the end of a section.
 * Problems already in the plan are reported, not errors; unknown or
 * unpublished codes are reported as unavailable.
 */
export async function addPlanItems(input: AddPlanItemsInput): Promise<ActionResult<AddPlanItemsResult>> {
  return runAction(async () => {
    const { user } = await requireAdminScopeAction();
    const parsed = addItemsSchema.parse(input);
    const codes = [...new Set(parsed.problemCodes.map((c) => c.toUpperCase()))];
    const out = await db.$transaction(async (tx) => {
      const plan = await lockPlan(tx, parsed.planId);
      const section = await tx.studyPlanSection.findUnique({ where: { id: parsed.sectionId }, select: { planId: true } });
      if (!section || section.planId !== plan.id) throw new NotFoundError("That section was not found.");
      const problems = await tx.problem.findMany({
        where: { displayCode: { in: codes, mode: "insensitive" }, status: "PUBLISHED", liveVersionId: { not: null } },
        select: { id: true, displayCode: true },
      });
      const byCode = new Map(problems.map((p) => [p.displayCode.toUpperCase(), p]));
      const existing = await tx.studyPlanItem.findMany({
        where: { planId: plan.id, problemId: { in: problems.map((p) => p.id) } },
        select: { problemId: true },
      });
      const inPlan = new Set(existing.map((e) => e.problemId));
      const added: string[] = [];
      const alreadyInPlan: string[] = [];
      const unavailable: string[] = [];
      const last = await tx.studyPlanItem.findFirst({
        where: { sectionId: parsed.sectionId },
        orderBy: { sortOrder: "desc" },
        select: { sortOrder: true },
      });
      let next = (last?.sortOrder ?? -1) + 1;
      const rows: { planId: string; sectionId: string; problemId: string; sortOrder: number }[] = [];
      for (const code of codes) {
        const problem = byCode.get(code);
        if (!problem) unavailable.push(code);
        else if (inPlan.has(problem.id)) alreadyInPlan.push(problem.displayCode);
        else {
          rows.push({ planId: plan.id, sectionId: parsed.sectionId, problemId: problem.id, sortOrder: next++ });
          inPlan.add(problem.id);
          added.push(problem.displayCode);
        }
      }
      if (rows.length > 0) await tx.studyPlanItem.createMany({ data: rows });
      const { itemsTotal } = await recountStudyPlan(tx, plan.id);
      if (rows.length > 0) await touch(tx, plan.id, user.id);
      return { plan, result: { added, alreadyInPlan, unavailable, itemsTotal } };
    });
    if (out.result.added.length > 0) {
      await record(user.id, "plan.items.added", out.plan.id, {
        sectionId: parsed.sectionId,
        problemCodes: out.result.added,
        itemsTotal: out.result.itemsTotal,
      });
    }
    revalidatePlan(out.plan);
    return out.result;
  }, "addPlanItems");
}

const moveItemSchema = z.object({
  itemId: idSchema,
  sectionId: idSchema,
  position: z.coerce.number().int().min(0).max(10_000),
});
export type MovePlanItemInput = z.input<typeof moveItemSchema>;

/** Move an item to a section (possibly another one of the same plan) at a 0-based position. */
export async function movePlanItem(input: MovePlanItemInput): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const { user } = await requireAdminScopeAction();
    const parsed = moveItemSchema.parse(input);
    const plan = await db.$transaction(async (tx) => {
      const item = await tx.studyPlanItem.findUnique({ where: { id: parsed.itemId }, select: { planId: true } });
      if (!item) throw new NotFoundError("That plan item was not found.");
      const locked = await lockPlan(tx, item.planId);
      const fresh = await tx.studyPlanItem.findUnique({
        where: { id: parsed.itemId },
        select: { planId: true, sectionId: true },
      });
      if (!fresh || fresh.planId !== locked.id) throw new NotFoundError("That plan item was not found.");
      const target = await tx.studyPlanSection.findUnique({ where: { id: parsed.sectionId }, select: { planId: true } });
      if (!target || target.planId !== locked.id) throw new NotFoundError("That section was not found.");

      const siblings = await tx.studyPlanItem.findMany({
        where: { sectionId: parsed.sectionId, id: { not: parsed.itemId } },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        select: { id: true },
      });
      const order = siblings.map((s) => s.id);
      order.splice(Math.min(parsed.position, order.length), 0, parsed.itemId);
      for (const [i, id] of order.entries()) {
        await tx.studyPlanItem.update({
          where: { id },
          data: id === parsed.itemId ? { sectionId: parsed.sectionId, sortOrder: i } : { sortOrder: i },
        });
      }
      if (fresh.sectionId !== parsed.sectionId) await renumberItems(tx, fresh.sectionId);
      await touch(tx, locked.id, user.id);
      return locked;
    });
    await record(user.id, "plan.item.moved", plan.id, {
      itemId: parsed.itemId,
      sectionId: parsed.sectionId,
      position: parsed.position,
    });
    revalidatePlan(plan);
    return { id: parsed.itemId };
  }, "movePlanItem");
}

const removeItemSchema = z.object({ itemId: idSchema });
export type RemovePlanItemInput = z.input<typeof removeItemSchema>;

export async function removePlanItem(input: RemovePlanItemInput): Promise<ActionResult<{ itemsTotal: number }>> {
  return runAction(async () => {
    const { user } = await requireAdminScopeAction();
    const parsed = removeItemSchema.parse(input);
    const out = await db.$transaction(async (tx) => {
      const item = await tx.studyPlanItem.findUnique({ where: { id: parsed.itemId }, select: { planId: true } });
      if (!item) throw new NotFoundError("That plan item was not found.");
      const plan = await lockPlan(tx, item.planId);
      const fresh = await tx.studyPlanItem.findUnique({
        where: { id: parsed.itemId },
        select: { planId: true, sectionId: true, problem: { select: { displayCode: true } } },
      });
      if (!fresh || fresh.planId !== plan.id) throw new NotFoundError("That plan item was not found.");
      await tx.studyPlanItem.delete({ where: { id: parsed.itemId } });
      await renumberItems(tx, fresh.sectionId);
      const { itemsTotal } = await recountStudyPlan(tx, plan.id);
      if (itemsTotal === 0 && plan.published) {
        await tx.studyPlan.update({ where: { id: plan.id }, data: { published: false } });
      }
      await touch(tx, plan.id, user.id);
      return { plan, itemsTotal, problemCode: fresh.problem.displayCode };
    });
    await record(user.id, "plan.item.removed", out.plan.id, {
      itemId: parsed.itemId,
      problemCode: out.problemCode,
      itemsTotal: out.itemsTotal,
    });
    revalidatePlan(out.plan);
    return { itemsTotal: out.itemsTotal };
  }, "removePlanItem");
}
