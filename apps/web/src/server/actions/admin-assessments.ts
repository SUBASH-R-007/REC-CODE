"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  ASSESSMENT_LIMITS,
  ASSESSMENT_PROCTOR_MODES,
  ASSESSMENT_PROCTORED_MESSAGE,
  FOCUS_LIMIT_ACTIONS,
  LAB_NEEDS_ALLOWLIST_MESSAGE,
  PLACEMENT_REQUIRES_LAB_MESSAGE,
  parseCidr,
  mayAffectPlacement,
  requiresCidrAllowlist,
} from "@recx/shared";
import { audit } from "@/lib/audit";
import { requireActionRole } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { ConflictError, NotFoundError, ValidationError, runAction, type ActionResult } from "@/lib/errors";
import { requestIpHash } from "@/lib/ip";

/**
 * Assessment authoring, staff only (capability "assessments.manage").
 *
 * The sitting engine, the telemetry, the invigilation surface and the
 * integrity queue have all existed since Phase 6. What never existed was a
 * way to CREATE one: every assessment in this repository was made by a test
 * fixture. This is that way.
 *
 * Every rule the database enforces is checked here too, so a mistake is a
 * sentence an admin can act on rather than a constraint violation: the
 * window, the duration, the placement rule, a lab session's allowlist, the
 * frozen problem version, and — new in Phase 12a — that an assessment is
 * always proctored.
 *
 * What these actions deliberately cannot do: change the terms of an
 * assessment that has left DRAFT. `Assessment_published_immutable` refuses
 * it in the database, and nothing here tries. A candidate's result must mean
 * what it meant when they sat it.
 */

const dateFromInput = (field: string) =>
  z
    .string()
    .trim()
    .min(1, `Give the assessment a ${field}.`)
    .transform((value, ctx) => {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `That ${field} is not a date and time.` });
        return z.NEVER;
      }
      return date;
    });

const intFromInput = (options: { min: number; max: number; label: string }) =>
  z.union([z.string().trim(), z.number()]).transform((value, ctx) => {
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

const idSchema = z.string().trim().min(1).max(64);

const createSchema = z
  .object({
    slug: z
      .string()
      .trim()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lower-case words joined by hyphens, e.g. cse-2027-midsem.")
      .max(80),
    title: z.string().trim().min(1, "Give the assessment a title.").max(ASSESSMENT_LIMITS.title.max),
    instructions: z
      .string()
      .trim()
      .min(1, "Write the instructions candidates read before they start.")
      .max(ASSESSMENT_LIMITS.instructions.max),
    // The one enum with no NONE in it: an assessment is always proctored.
    proctorMode: z.enum(ASSESSMENT_PROCTOR_MODES as unknown as [string, ...string[]], {
      errorMap: () => ({ message: ASSESSMENT_PROCTORED_MESSAGE }),
    }),
    affectsPlacementEligibility: z.boolean(),
    opensAt: dateFromInput("opening time"),
    closesAt: dateFromInput("closing time"),
    durationMinutes: intFromInput({
      min: Math.ceil(ASSESSMENT_LIMITS.durationSec.min / 60),
      max: Math.floor(ASSESSMENT_LIMITS.durationSec.max / 60),
      label: "The duration",
    }),
    maxAttempts: intFromInput({ ...ASSESSMENT_LIMITS.maxAttempts, label: "The attempt limit" }),
    maxFocusWarnings: intFromInput({ ...ASSESSMENT_LIMITS.maxFocusWarnings, label: "The focus warning limit" }),
    onLimit: z.enum(FOCUS_LIMIT_ACTIONS),
    strictMode: z.boolean(),
    audienceBatchYear: intFromInput({ min: 2000, max: 2100, label: "The batch" }).nullable().optional(),
    audienceDepartmentCode: z.string().trim().max(16).nullable().optional(),
    audienceSection: z.string().trim().max(4).nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.closesAt <= value.opensAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["closesAt"],
        message: "The assessment must close after it opens.",
      });
    }
    if (value.affectsPlacementEligibility && !mayAffectPlacement(value.proctorMode as never)) {
      // Reported on the claim, not on the proctoring: an admin who meant to
      // run an ordinary test should drop the claim, not escalate the watching.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["affectsPlacementEligibility"],
        message: PLACEMENT_REQUIRES_LAB_MESSAGE,
      });
    }
    // The audience CHECK, said in words: a section only means something
    // inside a batch and a department.
    if (value.audienceSection && !(value.audienceBatchYear && value.audienceDepartmentCode)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["audienceSection"],
        message: "A section needs a batch and a department too.",
      });
    }
  });
export type CreateAssessmentInput = z.input<typeof createSchema>;

export async function createAssessment(
  input: CreateAssessmentInput,
): Promise<ActionResult<{ id: string; slug: string }>> {
  return runAction(async () => {
    const actor = await requireActionRole("ADMIN", "SUPER_ADMIN");
    const parsed = createSchema.parse(input);

    const existing = await db.assessment.findUnique({ where: { slug: parsed.slug }, select: { id: true } });
    if (existing) throw new ConflictError("An assessment already uses that address.");

    const assessment = await db.assessment.create({
      data: {
        slug: parsed.slug,
        title: parsed.title,
        instructions: parsed.instructions,
        proctorMode: parsed.proctorMode as never,
        affectsPlacementEligibility: parsed.affectsPlacementEligibility,
        opensAt: parsed.opensAt,
        closesAt: parsed.closesAt,
        durationSec: parsed.durationMinutes * 60,
        maxAttempts: parsed.maxAttempts,
        maxFocusWarnings: parsed.maxFocusWarnings,
        onLimit: parsed.onLimit,
        strictMode: parsed.strictMode,
        audienceBatchYear: parsed.audienceBatchYear ?? null,
        audienceDepartmentCode: parsed.audienceDepartmentCode || null,
        audienceSection: parsed.audienceSection || null,
        createdById: actor.id,
      },
      select: { id: true, slug: true },
    });

    await audit({
      actorId: actor.id,
      action: "assessment.created",
      entityType: "Assessment",
      entityId: assessment.id,
      sensitivity: "SENSITIVE",
      metadata: {
        slug: assessment.slug,
        proctorMode: parsed.proctorMode,
        placement: String(parsed.affectsPlacementEligibility),
      },
      ipHash: await requestIpHash(),
    });
    revalidatePath("/admin/assessments");
    return assessment;
  }, "createAssessment");
}

const addProblemSchema = z.object({
  assessmentId: idSchema,
  problemSlug: z.string().trim().min(1),
  position: intFromInput({ min: ASSESSMENT_LIMITS.position.min, max: ASSESSMENT_LIMITS.position.max, label: "The position" }),
  points: intFromInput({ min: 1, max: 10_000, label: "Points" }),
});
export type AddAssessmentProblemInput = z.input<typeof addProblemSchema>;

/**
 * Pin a problem into an assessment at its LIVE frozen version, by id and
 * never as a pointer — the same rule a contest follows, and for the same
 * reason: a later revision must not change what a candidate was asked.
 */
export async function addAssessmentProblem(
  input: AddAssessmentProblemInput,
): Promise<ActionResult<{ id: string; position: number; revision: number }>> {
  return runAction(async () => {
    const actor = await requireActionRole("ADMIN", "SUPER_ADMIN");
    const parsed = addProblemSchema.parse(input);

    const assessment = await db.assessment.findUnique({
      where: { id: parsed.assessmentId },
      select: { id: true, slug: true, status: true },
    });
    if (!assessment) throw new NotFoundError("That assessment was not found.");
    if (assessment.status !== "DRAFT") {
      throw new ValidationError("A published assessment's question set is fixed. Create another assessment instead.");
    }

    const problem = await db.problem.findUnique({
      where: { slug: parsed.problemSlug },
      select: {
        liveVersionId: true,
        liveVersion: { select: { id: true, revision: true, frozenAt: true, compareMode: true } },
      },
    });
    if (!problem) throw new NotFoundError("No problem with that address.");
    if (!problem.liveVersion || problem.liveVersion.frozenAt === null) {
      throw new ValidationError("That problem is not published yet, so there is no frozen revision to pin.");
    }
    /**
     * Phase 12l. SPEC §11 keeps interactive problems out of high-stakes
     * assessments "until they have run cleanly through two practice
     * contests". The database refuses the pin too
     * (AssessmentProblem_no_interactive); this is the sentence an admin
     * reads instead of a constraint violation.
     */
    if (problem.liveVersion.compareMode === "INTERACTIVE") {
      throw new ValidationError(
        "An interactive problem is not sat in an assessment yet: it has to run cleanly through two practice contests first. Put it in a contest or leave it in practice.",
      );
    }

    try {
      const row = await db.assessmentProblem.create({
        data: {
          assessmentId: assessment.id,
          problemVersionId: problem.liveVersion.id,
          position: parsed.position,
          points: parsed.points,
        },
        select: { id: true, position: true },
      });
      await audit({
        actorId: actor.id,
        action: "assessment.problem_added",
        entityType: "Assessment",
        entityId: assessment.id,
        sensitivity: "SENSITIVE",
        metadata: {
          position: String(row.position),
          problem: parsed.problemSlug,
          revision: String(problem.liveVersion.revision),
        },
        ipHash: await requestIpHash(),
      });
      revalidatePath(`/admin/assessments/${assessment.id}`);
      return { ...row, revision: problem.liveVersion.revision };
    } catch {
      throw new ConflictError("That position is taken, or that problem is already in this assessment.");
    }
  }, "addAssessmentProblem");
}

const removeProblemSchema = z.object({ assessmentProblemId: idSchema });
export type RemoveAssessmentProblemInput = z.input<typeof removeProblemSchema>;

export async function removeAssessmentProblem(
  input: RemoveAssessmentProblemInput,
): Promise<ActionResult<{ position: number }>> {
  return runAction(async () => {
    const actor = await requireActionRole("ADMIN", "SUPER_ADMIN");
    const parsed = removeProblemSchema.parse(input);
    const row = await db.assessmentProblem.findUnique({
      where: { id: parsed.assessmentProblemId },
      select: { id: true, position: true, assessment: { select: { id: true, status: true } } },
    });
    if (!row) throw new NotFoundError("That question was not found.");
    if (row.assessment.status !== "DRAFT") {
      throw new ValidationError("A published assessment's question set is fixed.");
    }
    await db.assessmentProblem.delete({ where: { id: row.id } });
    await audit({
      actorId: actor.id,
      action: "assessment.problem_removed",
      entityType: "Assessment",
      entityId: row.assessment.id,
      sensitivity: "SENSITIVE",
      metadata: { position: String(row.position) },
      ipHash: await requestIpHash(),
    });
    revalidatePath(`/admin/assessments/${row.assessment.id}`);
    return { position: row.position };
  }, "removeAssessmentProblem");
}

const sessionSchema = z
  .object({
    assessmentId: idSchema,
    label: z.string().trim().min(1, "Give the hall a label.").max(80),
    room: z.string().trim().max(80).nullable().optional(),
    startsAt: dateFromInput("start"),
    endsAt: dateFromInput("end"),
    capacity: intFromInput({ ...ASSESSMENT_LIMITS.capacity, label: "The capacity" }),
    allowedCidrs: z.array(z.string().trim()).max(50),
  })
  .superRefine((value, ctx) => {
    if (value.endsAt <= value.startsAt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endsAt"], message: "The hall must close after it opens." });
    }
    for (const [i, cidr] of value.allowedCidrs.entries()) {
      if (parseCidr(cidr) === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["allowedCidrs", i],
          message: `${cidr} is not a network in CIDR form (for example 10.21.0.0/16).`,
        });
      }
    }
  });
export type ScheduleExamSessionInput = z.input<typeof sessionSchema>;

/**
 * A hall. For a LAB_SUPERVISED assessment the allowlist IS the enforcement
 * (SPEC §5), so an empty one is refused here and by
 * `ExamSession_lab_allowlist` — a lab sitting with nothing proctoring it is
 * the one shape this must never take.
 */
export async function scheduleExamSession(
  input: ScheduleExamSessionInput,
): Promise<ActionResult<{ id: string; label: string }>> {
  return runAction(async () => {
    const actor = await requireActionRole("ADMIN", "SUPER_ADMIN");
    const parsed = sessionSchema.parse(input);

    const assessment = await db.assessment.findUnique({
      where: { id: parsed.assessmentId },
      select: { id: true, status: true, proctorMode: true },
    });
    if (!assessment) throw new NotFoundError("That assessment was not found.");
    if (assessment.status === "ARCHIVED" || assessment.status === "CLOSED") {
      throw new ValidationError("That assessment is finished; it takes no more halls.");
    }
    if (requiresCidrAllowlist(assessment.proctorMode) && parsed.allowedCidrs.length === 0) {
      throw new ValidationError(LAB_NEEDS_ALLOWLIST_MESSAGE);
    }

    const session = await db.examSession.create({
      data: {
        assessmentId: assessment.id,
        label: parsed.label,
        room: parsed.room || null,
        startsAt: parsed.startsAt,
        endsAt: parsed.endsAt,
        capacity: parsed.capacity,
        allowedCidrs: parsed.allowedCidrs,
        createdById: actor.id,
      },
      select: { id: true, label: true },
    });
    await audit({
      actorId: actor.id,
      action: "assessment.session_scheduled",
      entityType: "Assessment",
      entityId: assessment.id,
      sensitivity: "SENSITIVE",
      metadata: { label: session.label, networks: String(parsed.allowedCidrs.length) },
      ipHash: await requestIpHash(),
    });
    revalidatePath(`/admin/assessments/${assessment.id}`);
    return session;
  }, "scheduleExamSession");
}

const statusSchema = z.object({
  assessmentId: idSchema,
  to: z.enum(["PUBLISHED", "OPEN", "CLOSED", "ARCHIVED"]),
});
export type SetAssessmentStatusInput = z.input<typeof statusSchema>;

/** The transitions this action allows, and nothing else. ARCHIVED is terminal. */
const NEXT: Record<string, readonly string[]> = {
  DRAFT: ["PUBLISHED", "ARCHIVED"],
  PUBLISHED: ["OPEN", "ARCHIVED"],
  OPEN: ["CLOSED"],
  CLOSED: ["ARCHIVED"],
  ARCHIVED: [],
};

/**
 * Move an assessment along its lifecycle. Publishing is the moment the terms
 * stop being editable, so it is refused until there is something to sit: an
 * assessment with no questions would open on an empty paper, and a lab one
 * with no hall would have no allowlist to enforce.
 */
export async function setAssessmentStatus(
  input: SetAssessmentStatusInput,
): Promise<ActionResult<{ status: string }>> {
  return runAction(async () => {
    const actor = await requireActionRole("ADMIN", "SUPER_ADMIN");
    const parsed = statusSchema.parse(input);

    const assessment = await db.assessment.findUnique({
      where: { id: parsed.assessmentId },
      select: {
        id: true,
        slug: true,
        status: true,
        proctorMode: true,
        _count: { select: { problems: true, sessions: true } },
      },
    });
    if (!assessment) throw new NotFoundError("That assessment was not found.");
    if (!NEXT[assessment.status]?.includes(parsed.to)) {
      throw new ValidationError(`An assessment cannot go from ${assessment.status} to ${parsed.to}.`);
    }
    if (parsed.to === "PUBLISHED") {
      if (assessment._count.problems === 0) {
        throw new ValidationError("Add at least one question before publishing: an empty paper is not a test.");
      }
      if (requiresCidrAllowlist(assessment.proctorMode) && assessment._count.sessions === 0) {
        throw new ValidationError(
          "A lab-supervised assessment needs a hall with its network allowlist before it is published.",
        );
      }
    }

    const moved = await db.assessment.updateMany({
      where: { id: assessment.id, status: assessment.status },
      data: { status: parsed.to },
    });
    if (moved.count !== 1) throw new ConflictError("Somebody else moved this assessment. Reload the page.");

    await audit({
      actorId: actor.id,
      action: "assessment.status_changed",
      entityType: "Assessment",
      entityId: assessment.id,
      sensitivity: "SENSITIVE",
      metadata: { slug: assessment.slug, from: assessment.status, to: parsed.to },
      ipHash: await requestIpHash(),
    });
    revalidatePath("/admin/assessments");
    revalidatePath(`/admin/assessments/${assessment.id}`);
    return { status: parsed.to };
  }, "setAssessmentStatus");
}
