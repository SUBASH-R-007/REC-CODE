"use server";

import { revalidatePath } from "next/cache";
import { canFreeze, FREEZE_MIN_DURATION_MINUTES } from "@recx/shared";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { requireActionRole } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { ConflictError, NotFoundError, ValidationError, runAction, type ActionResult } from "@/lib/errors";
import { requestIpHash } from "@/lib/ip";

/**
 * Contest authoring, staff only (capability "contests.manage").
 *
 * The rules the database also enforces (migration 20261019120000) are
 * checked here too, so a mistake is a readable message rather than a
 * constraint violation: the window, the 90-minute freeze rule, a frozen
 * problem version, and a published contest's fixed window.
 *
 * AdminScope: a COHORT contest must name a cohort the author can see. A
 * PUBLIC contest is the whole college, so only a SUPER_ADMIN may create one
 * — an ADMIN scoped to one department must not address everybody.
 */

const CONTEST_KINDS = ["ICPC", "SUBTASK"] as const;

/**
 * These actions are called from forms, so the declared INPUT is what a form
 * posts: strings. `z.coerce.date()` would accept a string at runtime but
 * types its input as Date, which makes every caller cast — so the parsing is
 * explicit instead, and an unparseable value gets a readable message.
 */
const dateFromInput = (field: string) =>
  z
    .string()
    .trim()
    .min(1, `Give the contest a ${field}.`)
    .transform((value, ctx) => {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `That ${field} is not a date and time.` });
        return z.NEVER;
      }
      return date;
    });

const intFromInput = (options: { min: number; max: number; label: string }) =>
  z
    .union([z.string().trim(), z.number()])
    .transform((value, ctx) => {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${options.label} must be a whole number.` });
        return z.NEVER;
      }
      if (n < options.min || n > options.max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${options.label} must be between ${options.min} and ${options.max}.`,
        });
        return z.NEVER;
      }
      return n;
    });

const createSchema = z
  .object({
    slug: z
      .string()
      .trim()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lower-case words joined by hyphens, e.g. div2-round-7.")
      .max(80),
    title: z.string().trim().min(1, "Give the contest a title.").max(120),
    rules: z.string().trim().min(1, "Write the rules students see before they start.").max(20_000),
    kind: z.enum(CONTEST_KINDS),
    startsAt: dateFromInput("start"),
    endsAt: dateFromInput("end"),
    freezeMinutes: intFromInput({ min: 0, max: 600, label: "The freeze" }),
    isRated: z.boolean(),
    visibility: z.enum(["PUBLIC", "COHORT"]),
    audienceBatchYear: intFromInput({ min: 2000, max: 2100, label: "The batch" }).nullable().optional(),
    audienceDepartmentCode: z.string().trim().max(16).nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.endsAt <= value.startsAt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endsAt"], message: "The contest must end after it starts." });
      return;
    }
    const window = { startsAt: value.startsAt, endsAt: value.endsAt, freezeMinutes: value.freezeMinutes };
    if (value.freezeMinutes > 0 && !canFreeze(window)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["freezeMinutes"],
        message: `A freeze needs a contest of at least ${FREEZE_MIN_DURATION_MINUTES} minutes, and must be shorter than the contest. Use 0 for no freeze.`,
      });
    }
  });
export type CreateContestInput = z.input<typeof createSchema>;

export async function createContest(input: CreateContestInput): Promise<ActionResult<{ id: string; slug: string }>> {
  return runAction(async () => {
    const actor = await requireActionRole("ADMIN", "SUPER_ADMIN");
    const parsed = createSchema.parse(input);

    if (parsed.visibility === "PUBLIC" && actor.role !== "SUPER_ADMIN") {
      throw new ValidationError(
        "Only a super-admin can run a college-wide contest. Choose a cohort, or ask a super-admin.",
      );
    }
    if (parsed.visibility === "COHORT" && !parsed.audienceBatchYear && !parsed.audienceDepartmentCode) {
      throw new ValidationError("A cohort contest needs a batch, a department, or both.");
    }

    const existing = await db.contest.findUnique({ where: { slug: parsed.slug }, select: { id: true } });
    if (existing) throw new ConflictError("A contest already uses that address.");

    const contest = await db.contest.create({
      data: {
        slug: parsed.slug,
        title: parsed.title,
        rules: parsed.rules,
        kind: parsed.kind,
        status: "DRAFT",
        visibility: parsed.visibility,
        startsAt: parsed.startsAt,
        endsAt: parsed.endsAt,
        freezeMinutes: parsed.freezeMinutes,
        isRated: parsed.isRated,
        audienceBatchYear: parsed.visibility === "COHORT" ? (parsed.audienceBatchYear ?? null) : null,
        audienceDepartmentCode: parsed.visibility === "COHORT" ? (parsed.audienceDepartmentCode ?? null) : null,
        createdById: actor.id,
      },
      select: { id: true, slug: true },
    });

    await audit({
      actorId: actor.id,
      action: "contest.created",
      entityType: "Contest",
      entityId: contest.id,
      sensitivity: "SENSITIVE",
      metadata: { slug: contest.slug, kind: parsed.kind, rated: String(parsed.isRated) },
      ipHash: await requestIpHash(),
    });
    revalidatePath("/admin/contests");
    return contest;
  }, "createContest");
}

const addProblemSchema = z.object({
  contestId: z.string().trim().min(1),
  /** The problem's slug; its LIVE frozen version is pinned at this moment. */
  problemSlug: z.string().trim().min(1),
  index: z
    .string()
    .trim()
    .regex(/^[A-Z]{1,2}$/, "Use a letter, e.g. A or AB."),
  points: intFromInput({ min: 1, max: 10_000, label: "Points" }),
});
export type AddContestProblemInput = z.input<typeof addProblemSchema>;

/**
 * Pin a problem into a contest.
 *
 * The version pinned is the problem's live version AT THIS MOMENT, and it is
 * stored by id — never as a pointer. A later revision of the problem does
 * not change what this contest asks, which is the whole point of §4a, and
 * the ContestProblem_frozen_version trigger refuses an unfrozen one.
 */
export async function addContestProblem(
  input: AddContestProblemInput,
): Promise<ActionResult<{ id: string; index: string; revision: number }>> {
  return runAction(async () => {
    const actor = await requireActionRole("ADMIN", "SUPER_ADMIN");
    const parsed = addProblemSchema.parse(input);

    const contest = await db.contest.findUnique({
      where: { id: parsed.contestId },
      select: { id: true, slug: true, status: true },
    });
    if (!contest) throw new NotFoundError("That contest was not found.");
    if (contest.status !== "DRAFT") {
      throw new ValidationError("A published contest's problem set is fixed. Create another contest instead.");
    }

    const problem = await db.problem.findUnique({
      where: { slug: parsed.problemSlug },
      select: {
        id: true,
        liveVersionId: true,
        liveVersion: { select: { id: true, revision: true, frozenAt: true } },
      },
    });
    if (!problem) throw new NotFoundError("No problem with that address.");
    if (!problem.liveVersion || problem.liveVersion.frozenAt === null) {
      throw new ValidationError("That problem is not published yet, so there is no frozen revision to pin.");
    }

    try {
      const row = await db.contestProblem.create({
        data: {
          contestId: contest.id,
          problemVersionId: problem.liveVersion.id,
          index: parsed.index,
          points: parsed.points,
        },
        select: { id: true, index: true },
      });
      await audit({
        actorId: actor.id,
        action: "contest.problem_added",
        entityType: "Contest",
        entityId: contest.id,
        sensitivity: "SENSITIVE",
        metadata: {
          index: row.index,
          problem: parsed.problemSlug,
          revision: String(problem.liveVersion.revision),
        },
        ipHash: await requestIpHash(),
      });
      revalidatePath(`/admin/contests/${contest.id}`);
      return { ...row, revision: problem.liveVersion.revision };
    } catch {
      throw new ConflictError("That letter is taken, or that problem is already in this contest.");
    }
  }, "addContestProblem");
}

const removeProblemSchema = z.object({ contestProblemId: z.string().trim().min(1) });
export type RemoveContestProblemInput = z.input<typeof removeProblemSchema>;

export async function removeContestProblem(input: RemoveContestProblemInput): Promise<ActionResult<{ index: string }>> {
  return runAction(async () => {
    const actor = await requireActionRole("ADMIN", "SUPER_ADMIN");
    const parsed = removeProblemSchema.parse(input);

    const row = await db.contestProblem.findUnique({
      where: { id: parsed.contestProblemId },
      select: { id: true, index: true, contest: { select: { id: true, status: true } } },
    });
    if (!row) throw new NotFoundError("That contest problem was not found.");
    if (row.contest.status !== "DRAFT") {
      throw new ValidationError("A published contest's problem set is fixed.");
    }

    await db.contestProblem.delete({ where: { id: row.id } });
    await audit({
      actorId: actor.id,
      action: "contest.problem_removed",
      entityType: "Contest",
      entityId: row.contest.id,
      sensitivity: "SENSITIVE",
      metadata: { index: row.index },
      ipHash: await requestIpHash(),
    });
    revalidatePath(`/admin/contests/${row.contest.id}`);
    return { index: row.index };
  }, "removeContestProblem");
}

const publishSchema = z.object({ contestId: z.string().trim().min(1) });
export type PublishContestInput = z.input<typeof publishSchema>;

/**
 * Publish a draft: students can see it and register, and the window becomes
 * fixed (the Contest_rating_once trigger refuses a later change to startsAt,
 * endsAt, kind or isRated once the contest leaves DRAFT).
 */
export async function publishContest(input: PublishContestInput): Promise<ActionResult<{ slug: string }>> {
  return runAction(async () => {
    const actor = await requireActionRole("ADMIN", "SUPER_ADMIN");
    const parsed = publishSchema.parse(input);

    const contest = await db.contest.findUnique({
      where: { id: parsed.contestId },
      select: { id: true, slug: true, status: true, endsAt: true, _count: { select: { problems: true } } },
    });
    if (!contest) throw new NotFoundError("That contest was not found.");
    if (contest.status !== "DRAFT") throw new ConflictError("That contest is already published.");
    if (contest._count.problems === 0) {
      throw new ValidationError("Add at least one problem before publishing.");
    }
    if (contest.endsAt <= new Date()) {
      throw new ValidationError("That contest's window has already passed. Change the window first.");
    }

    await db.contest.update({ where: { id: contest.id }, data: { status: "PUBLISHED" } });
    await audit({
      actorId: actor.id,
      action: "contest.published",
      entityType: "Contest",
      entityId: contest.id,
      sensitivity: "SENSITIVE",
      metadata: { slug: contest.slug, problems: String(contest._count.problems) },
      ipHash: await requestIpHash(),
    });
    revalidatePath("/admin/contests");
    revalidatePath("/contests");
    return { slug: contest.slug };
  }, "publishContest");
}
