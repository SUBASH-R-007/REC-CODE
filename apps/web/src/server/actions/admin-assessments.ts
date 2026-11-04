"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  ASSESSMENT_LIMITS,
  ASSESSMENT_PROCTOR_MODES,
  ASSESSMENT_PROCTORED_MESSAGE,
  FOCUS_LIMIT_ACTIONS,
  LAB_NEEDS_ALLOWLIST_MESSAGE,
  isLanguageKey,
  normalisePaperLanguages,
  paperLanguageLabel,
  PLACEMENT_REQUIRES_LAB_MESSAGE,
  QUESTION_MODERATIONS,
  paperQuestionCount,
  parseCidr,
  parseSebKey,
  mayAffectPlacement,
  requiresCidrAllowlist,
  type QuestionModeration,
} from "@recx/shared";
import { audit } from "@/lib/audit";
import { requireActionRole } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { AppError, ConflictError, NotFoundError, ValidationError, runAction, type ActionResult } from "@/lib/errors";
import { requestIpHash } from "@/lib/ip";
import { acceptedLanguagesFor } from "@/lib/exam/language";

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
    /**
     * Phase 12s. Refuse a paste into the editor that was not copied inside
     * the sitting. Off by default, and a watching knob rather than a term
     * of the result, so it sits with strictMode rather than in the frozen
     * tuple.
     */
    refuseOutsidePaste: z.boolean().optional().default(false),
    /** Phase 12s. Open the sitting in its own window; falls back to a tab. */
    sitInPopup: z.boolean().optional().default(false),
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
        refuseOutsidePaste: parsed.refuseOutsidePaste,
        sitInPopup: parsed.sitInPopup,
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

    // The mirror of the check in addAssessmentMcq: one numbered list, and
    // the author hears about it in words rather than as a reference code.
    const clash = await db.assessmentMcq.findFirst({
      where: { assessmentId: assessment.id, position: parsed.position },
      select: { id: true },
    });
    if (clash) {
      throw new ValidationError(
        `Position ${parsed.position} is already a multiple-choice question on this paper. A candidate sees one numbered list, so pick another number.`,
      );
    }

    const problem = await db.problem.findUnique({
      where: { slug: parsed.problemSlug },
      select: {
        liveVersionId: true,
        liveVersion: {
          select: { id: true, revision: true, frozenAt: true, compareMode: true, ioMode: true, maxEditedLines: true },
        },
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

    /**
     * Phase 12m. A debugging problem's edit budget is refused before the
     * row, in the submit and run actions; a sitting submits every answer
     * at the end and cannot refuse one without throwing away work the
     * candidate can no longer redo. So the pin is refused instead, here
     * and in the database (AssessmentProblem_no_debug_budget).
     */
    if (problem.liveVersion.maxEditedLines !== null) {
      throw new ValidationError(
        "A debugging problem is not sat in an assessment yet: a sitting submits every answer at the end, so it cannot refuse one that changed too many lines. Put it in a contest or leave it in practice.",
      );
    }

    /**
     * Phase 12n. The practice workspace is the only surface that knows an
     * output-only problem: the answer box, the one language, the data
     * without the expected answer, no Run. A sitting builds its own editor
     * and submits every answer in one language, so the pin is refused here
     * and in the database (AssessmentProblem_no_output_only).
     */
    if (problem.liveVersion.ioMode === "OUTPUT_ONLY") {
      throw new ValidationError(
        "An output-only problem is not sat in an assessment yet: a sitting gives every question the same code editor, and this one wants the answer itself. Put it in a contest or leave it in practice.",
      );
    }

    /**
     * Phase 12p. The fourth rule of this shape, and the kind that was
     * missing one: a sitting chooses ONE language for the whole paper and
     * the exam submit route only accepts a toolchain language, so a SQL
     * question would be a C++ editor over a problem that wants a query —
     * and the candidate would discover it mid-sitting. Refused here and in
     * the database (AssessmentProblem_no_sql).
     */
    if (problem.liveVersion.ioMode === "SQL") {
      throw new ValidationError(
        "A SQL problem is not sat in an assessment yet: a sitting gives every question the same code editor and submits every answer in one programming language. Put it in a contest or leave it in practice.",
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

/**
 * The multiple-choice half of a paper (Phase 12r).
 *
 * `options` arrives as the author typed them, one per line, because that is
 * how somebody writes four options: a repeating set of fields for a thing
 * with no fixed count is a form nobody enjoys, and a textarea is what the
 * aptitude importer already takes. Blank lines are dropped rather than
 * refused — a trailing newline is not a mistake worth a red message.
 *
 * `correctIndex` is 1-based in the form and 0-based in the row, because an
 * author counting options on a screen starts at one and every CHECK and
 * every comparison downstream starts at zero. Converted here, once, at the
 * boundary.
 */
const addMcqSchema = z.object({
  assessmentId: idSchema,
  position: intFromInput({ min: ASSESSMENT_LIMITS.position.min, max: ASSESSMENT_LIMITS.position.max, label: "The position" }),
  points: intFromInput({ min: 1, max: 10_000, label: "Points" }),
  stem: z.string().trim().min(1, "Write the question.").max(4_000, "That question is too long."),
  options: z.string().max(4_000, "Those options are too long."),
  /** 1-based, as the author sees them. */
  answer: intFromInput({ min: 1, max: 8, label: "The answer" }),
});
export type AddAssessmentMcqInput = z.input<typeof addMcqSchema>;

const removeMcqSchema = z.object({ assessmentMcqId: idSchema });
export type RemoveAssessmentMcqInput = z.input<typeof removeMcqSchema>;

export async function addAssessmentMcq(
  input: AddAssessmentMcqInput,
): Promise<ActionResult<{ id: string; position: number; options: number }>> {
  return runAction(async () => {
    const actor = await requireActionRole("ADMIN", "SUPER_ADMIN");
    const parsed = addMcqSchema.parse(input);

    const assessment = await db.assessment.findUnique({
      where: { id: parsed.assessmentId },
      select: { id: true, status: true },
    });
    if (!assessment) throw new NotFoundError("That assessment was not found.");
    if (assessment.status !== "DRAFT") {
      throw new ValidationError("A published assessment's question set is fixed. Create another assessment instead.");
    }

    const options = parsed.options
      .split(/\r?\n/)
      .map((option) => option.trim())
      .filter((option) => option.length > 0);
    if (options.length < 2) throw new ValidationError("Give at least two options, one per line. One option is not a choice.");
    if (options.length > 8) throw new ValidationError("Eight options is the most a question can have.");
    if (new Set(options).size !== options.length) {
      // Not a database rule, but a question with the same option twice has
      // two right answers or none, and the author is the only person who
      // can still fix it.
      throw new ValidationError("Two of those options are identical.");
    }
    if (parsed.answer > options.length) {
      throw new ValidationError(`There are only ${options.length} options, so the answer cannot be number ${parsed.answer}.`);
    }

    /**
     * The palette is one numbered list, said here so an author reads a
     * sentence. `AssessmentMcq_position_free` refuses it too and is the
     * backstop — but a trigger raised inside `runAction` becomes
     * "Something went wrong, quote reference …", which tells whoever is
     * building the paper nothing they can act on.
     */
    const clash = await db.assessmentProblem.findFirst({
      where: { assessmentId: assessment.id, position: parsed.position },
      select: { id: true },
    });
    if (clash) {
      throw new ValidationError(
        `Position ${parsed.position} is already a coding question on this paper. A candidate sees one numbered list, so pick another number.`,
      );
    }

    const row = await db.assessmentMcq.create({
      data: {
        assessmentId: assessment.id,
        position: parsed.position,
        stem: parsed.stem,
        options,
        // 1-based in the form, 0-based in the row.
        correctIndex: parsed.answer - 1,
        points: parsed.points,
      },
      select: { id: true, position: true },
    });
    await audit({
      actorId: actor.id,
      action: "assessment.mcq_added",
      entityType: "Assessment",
      entityId: assessment.id,
      sensitivity: "SENSITIVE",
      // Never the answer: an audit row is read by more people than a paper is.
      metadata: { position: String(row.position), options: String(options.length) },
      ipHash: await requestIpHash(),
    });
    revalidatePath(`/admin/assessments/${assessment.id}`);
    return { id: row.id, position: row.position, options: options.length };
  }, "addAssessmentMcq");
}

export async function removeAssessmentMcq(
  input: RemoveAssessmentMcqInput,
): Promise<ActionResult<{ position: number }>> {
  return runAction(async () => {
    const actor = await requireActionRole("ADMIN", "SUPER_ADMIN");
    const parsed = removeMcqSchema.parse(input);
    const row = await db.assessmentMcq.findUnique({
      where: { id: parsed.assessmentMcqId },
      select: { id: true, position: true, assessment: { select: { id: true, status: true } } },
    });
    if (!row) throw new NotFoundError("That question was not found.");
    if (row.assessment.status !== "DRAFT") {
      throw new ValidationError("A published assessment's question set is fixed.");
    }
    await db.assessmentMcq.delete({ where: { id: row.id } });
    await audit({
      actorId: actor.id,
      action: "assessment.mcq_removed",
      entityType: "Assessment",
      entityId: row.assessment.id,
      sensitivity: "SENSITIVE",
      metadata: { position: String(row.position) },
      ipHash: await requestIpHash(),
    });
    revalidatePath(`/admin/assessments/${row.assessment.id}`);
    return { position: row.position };
  }, "removeAssessmentMcq");
}

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
        _count: { select: { problems: true, mcqs: true, sessions: true } },
      },
    });
    if (!assessment) throw new NotFoundError("That assessment was not found.");
    if (!NEXT[assessment.status]?.includes(parsed.to)) {
      throw new ValidationError(`An assessment cannot go from ${assessment.status} to ${parsed.to}.`);
    }
    if (parsed.to === "PUBLISHED") {
      // Either kind counts; see paperQuestionCount.
      if (paperQuestionCount({ problems: { length: assessment._count.problems }, mcqs: { length: assessment._count.mcqs } }) === 0) {
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

const releaseSchema = z.object({ assessmentId: idSchema, published: z.boolean() });
export type SetAssessmentResultsPublishedInput = z.input<typeof releaseSchema>;

/**
 * Release the marks to the candidates, or take them back (Phase 12y).
 *
 * Marking and releasing are two acts. A paper is marked the moment it is
 * handed in — the multiple-choice half at once, the coding half as the
 * judge works through it — and staff read that on the results page
 * immediately. None of it is a RESULT until somebody says so: a question
 * may have been wrong, the judge may have failed on one candidate, a whole
 * cohort may have tripped over a typo. Every one of those is fixable while
 * the marks are staff's own and none of them is fixable quietly once a
 * candidate has read a number.
 *
 * Taking it back is allowed, and that is not a loophole. The reason to
 * release carefully is that a mistake reaches people; a product that made
 * the mistake permanent would be choosing its own dignity over theirs.
 * Both directions are audited, and the student page says a withdrawn
 * result is being checked rather than pretending it was never there.
 *
 * Still refused: releasing a DRAFT. There is nothing to release, and the
 * refusal says so rather than writing a timestamp onto a paper nobody has
 * sat.
 */
export async function setAssessmentResultsPublished(
  input: SetAssessmentResultsPublishedInput,
): Promise<ActionResult<{ published: boolean }>> {
  return runAction(async () => {
    const actor = await requireActionRole("ADMIN", "SUPER_ADMIN");
    const parsed = releaseSchema.parse(input);

    const assessment = await db.assessment.findUnique({
      where: { id: parsed.assessmentId },
      select: {
        id: true,
        slug: true,
        status: true,
        resultsPublishedAt: true,
        _count: { select: { attempts: true } },
      },
    });
    if (!assessment) throw new NotFoundError("That assessment was not found.");
    if (parsed.published && assessment.status === "DRAFT") {
      throw new ValidationError("A draft has no results to release. Publish the paper and let somebody sit it first.");
    }
    if (parsed.published === (assessment.resultsPublishedAt !== null)) {
      throw new ConflictError(
        parsed.published ? "These results are already released." : "These results are not released.",
      );
    }

    const now = new Date();
    const moved = await db.assessment.updateMany({
      // Conditional on what we read, so two people releasing at once does
      // not produce two different timestamps and two audit rows claiming
      // to be the release.
      where: { id: assessment.id, resultsPublishedAt: assessment.resultsPublishedAt },
      data: parsed.published
        ? { resultsPublishedAt: now, resultsPublishedById: actor.id }
        : { resultsPublishedAt: null, resultsPublishedById: null },
    });
    if (moved.count !== 1) throw new ConflictError("Somebody else changed this. Reload the page.");

    await audit({
      actorId: actor.id,
      action: parsed.published ? "assessment.results_released" : "assessment.results_withdrawn",
      entityType: "Assessment",
      entityId: assessment.id,
      sensitivity: "SENSITIVE",
      metadata: {
        slug: assessment.slug,
        candidates: assessment._count.attempts,
        releasedAt: parsed.published ? now.toISOString() : null,
      },
      ipHash: await requestIpHash(),
    });

    revalidatePath("/admin/assessments");
    revalidatePath(`/admin/assessments/${assessment.id}`);
    revalidatePath(`/admin/assessments/${assessment.id}/results`);
    revalidatePath("/assessments");
    return { published: parsed.published };
  }, "setAssessmentResultsPublished");
}

const sebKeysSchema = z
  .object({
    /** The hall whose own keys these are. */
    examSessionId: z.string().min(1).max(64),
    configKey: z.string().max(200),
    browserExamKey: z.string().max(200),
  })
  .strict();
export type SetSebKeysInput = z.input<typeof sebKeysSchema>;

/**
 * Save a hall's Safe Exam Browser keys (Phase 12z).
 *
 * The last link in the kiosk chain. 12y.8 generates the .seb file and the
 * readiness page hands it to SEB; SEB then sends `sha256(url + key)` on
 * every request and `verifySeb` compares it against the stored pair.
 * Until this action there was nowhere to put one: the keys were
 * `PlatformSetting` rows with no screen, so a KIOSK_SEB paper refused
 * every candidate with "no exam keys have been configured" and the only
 * cure was a hand-written SQL statement.
 *
 * On the HALL, not in a setting. The first draft wrote
 * `PlatformSetting["seb:<id>"]` from here and
 * `tests/repo/platform-setting-writes.test.ts` refused it: that table is
 * the super-admin's, reserved to five audited action files, and a STAFF
 * action writing it would widen who can write every platform setting. The
 * fence was right and the data was in the wrong place — a key rotates per
 * sitting and belongs beside the hall's network allowlist. The
 * college-wide default stays a platform setting, set by a super-admin,
 * and a hall's own pair wins over it (`sebKeysFor`).
 *
 * Audited at SECURITY, recording WHETHER each key was set and never
 * which: an audit row carrying the key would be a second copy of it in a
 * table more people can read.
 */
export async function setSebKeys(
  input: SetSebKeysInput,
): Promise<ActionResult<{ configKey: boolean; browserExamKey: boolean }>> {
  return runAction(async () => {
    const actor = await requireActionRole("ADMIN", "SUPER_ADMIN");
    const parsed = sebKeysSchema.parse(input);

    const hall = await db.examSession.findUnique({
      where: { id: parsed.examSessionId },
      select: { id: true, label: true, assessmentId: true },
    });
    if (!hall) throw new NotFoundError("That hall was not found.");

    const config = parseSebKey(parsed.configKey);
    const browser = parseSebKey(parsed.browserExamKey);
    if (!config.ok || !browser.ok) {
      throw new ValidationError(
        "A key is the hex digest Safe Exam Browser shows in its Config Tool — 64 characters of 0-9 and a-f. Copy it exactly, or leave the box empty to clear it.",
      );
    }

    await db.examSession.update({
      where: { id: hall.id },
      data: { sebConfigKey: config.key, sebBrowserExamKey: browser.key },
    });

    await audit({
      actorId: actor.id,
      action: "assessment.seb_keys_changed",
      entityType: "ExamSession",
      entityId: hall.id,
      sensitivity: "SECURITY",
      metadata: {
        assessmentId: hall.assessmentId,
        hall: hall.label,
        // Whether, never which.
        configKeySet: config.key !== null,
        browserExamKeySet: browser.key !== null,
      },
      ipHash: await requestIpHash(),
    });

    revalidatePath(`/admin/assessments/${hall.assessmentId}`);
    return { configKey: config.key !== null, browserExamKey: browser.key !== null };
  }, "setSebKeys");
}

const languagesSchema = z
  .object({
    assessmentId: idSchema,
    /**
     * The keys an administrator ticked. An empty list is a valid answer and
     * means "no restriction" — not "nothing", which is what makes the
     * checkbox list safe to clear.
     */
    languages: z.array(z.string().trim().min(1).max(32)).max(32),
  })
  .strict();
export type SetAssessmentLanguagesInput = z.input<typeof languagesSchema>;

/**
 * Choose which languages a paper may be answered in (Phase 13a).
 *
 * The thing a department could not say. A sitting had ONE language and
 * nobody chose it: `cpp20`, or whatever enabled toolchain key sorted
 * first, frozen into every attempt. Running a Python paper meant disabling
 * C++ for the whole college — every other exam and every practice page
 * included — and a candidate who writes Java sat down in front of a C++
 * editor with no way to change it.
 *
 * Three decisions here are worth stating.
 *
 * **Empty means every enabled language**, which is what every paper
 * already in the database holds. A paper nobody has restricted must not
 * become a paper nobody can sit.
 *
 * **An unknown key is refused by name**, rather than dropped quietly. The
 * reader (`normalisePaperLanguages`) drops what it does not recognise,
 * because it also reads rows written by older builds; a person ticking
 * boxes gets told.
 *
 * **A language with no enabled, current `LanguageConfig` is refused too.**
 * An administrator picking a toolchain this platform cannot run would be
 * promising candidates an editor whose every Run comes back "that language
 * is not available right now". The list is checked against what is
 * installed at the moment it is saved, and `paperLanguages()` intersects
 * again when a paper is sat, because a toolchain can be disabled in
 * between.
 *
 * Editable after the paper leaves DRAFT, unlike its window or its clock.
 * It cannot move under anybody sitting — the accepted set is frozen into
 * each attempt's layout at start — so the only thing an edit changes is
 * what the NEXT candidate is offered, and a department that forgot a
 * language an hour before the second hall has to be able to add it.
 */
export async function setAssessmentLanguages(
  input: SetAssessmentLanguagesInput,
): Promise<ActionResult<{ languages: string[] }>> {
  return runAction(async () => {
    const actor = await requireActionRole("ADMIN", "SUPER_ADMIN");
    const parsed = languagesSchema.parse(input);

    const assessment = await db.assessment.findUnique({
      where: { id: parsed.assessmentId },
      select: { id: true, slug: true, status: true, allowedLanguages: true },
    });
    if (!assessment) throw new NotFoundError("That assessment was not found.");

    const unknown = parsed.languages.filter((key) => !isLanguageKey(key));
    if (unknown.length > 0) {
      throw new ValidationError(`This platform has no language called ${unknown.join(", ")}.`);
    }
    const wanted = normalisePaperLanguages(parsed.languages);

    const installed = await db.languageConfig.findMany({
      where: { enabled: true, isCurrent: true },
      select: { key: true },
    });
    const available = new Set(normalisePaperLanguages(installed.map((row) => row.key)));
    const missing = wanted.filter((key) => !available.has(key));
    if (missing.length > 0) {
      throw new ValidationError(
        `${missing.map(paperLanguageLabel).join(", ")} is not enabled on this platform right now, so a candidate could not be judged in it. Ask a super-admin to enable the toolchain first, or leave it out.`,
      );
    }

    const before = normalisePaperLanguages(assessment.allowedLanguages);
    if (before.join(",") === wanted.join(",")) {
      throw new ConflictError("That is already what this paper accepts.");
    }

    await db.assessment.update({ where: { id: assessment.id }, data: { allowedLanguages: wanted } });

    await audit({
      actorId: actor.id,
      action: "assessment.languages_changed",
      entityType: "Assessment",
      entityId: assessment.id,
      // A term of the paper, changeable after publication: who widened or
      // narrowed what a cohort could answer in is exactly what a dispute
      // asks about.
      sensitivity: "SENSITIVE",
      metadata: {
        slug: assessment.slug,
        status: assessment.status,
        before,
        after: wanted,
        /** Said plainly, because an empty list does not read as "all". */
        restricted: wanted.length > 0,
      },
      ipHash: await requestIpHash(),
    });

    revalidatePath(`/admin/assessments/${assessment.id}`);
    revalidatePath("/admin/assessments");
    return { languages: wanted };
  }, "setAssessmentLanguages");
}

const questionLanguagesSchema = z
  .object({
    assessmentProblemId: idSchema,
    /** Empty means "every language the paper accepts", which is the default. */
    languages: z.array(z.string().trim().min(1).max(32)).max(32),
  })
  .strict();
export type SetQuestionLanguagesInput = z.input<typeof questionLanguagesSchema>;

/**
 * Narrow ONE question to some of the paper's languages (Phase 13c).
 *
 * "Answer this one in C" is a reasonable thing to ask of a question about
 * pointers, and a department should not have to make the whole paper C to
 * ask it. Empty is the default and means every language the paper
 * accepts.
 *
 * **It narrows and never widens.** A question accepting something the
 * paper does not would make the readiness page a lie -- that page names
 * the paper's languages before the clock starts -- so a key outside the
 * paper's set is refused here by name, and `questionLanguages()`
 * intersects again on read in case the paper is narrowed afterwards.
 *
 * Editable after the paper leaves DRAFT, like the paper's own list and
 * for the same reason: each candidate's set is frozen into their attempt
 * at start, so an edit reaches only the next one.
 */
export async function setQuestionLanguages(
  input: SetQuestionLanguagesInput,
): Promise<ActionResult<{ languages: string[] }>> {
  return runAction(async () => {
    const actor = await requireActionRole("ADMIN", "SUPER_ADMIN");
    const parsed = questionLanguagesSchema.parse(input);

    const question = await db.assessmentProblem.findUnique({
      where: { id: parsed.assessmentProblemId },
      select: {
        id: true,
        position: true,
        allowedLanguages: true,
        assessment: { select: { id: true, slug: true, status: true, allowedLanguages: true } },
        problemVersion: { select: { title: true } },
      },
    });
    if (!question) throw new NotFoundError("That question was not found.");

    const unknown = parsed.languages.filter((key) => !isLanguageKey(key));
    if (unknown.length > 0) {
      throw new ValidationError(`This platform has no language called ${unknown.join(", ")}.`);
    }
    const wanted = normalisePaperLanguages(parsed.languages);

    /**
     * Against the PAPER's accepted set, not against the catalogue. An
     * empty paper list means the paper accepts every enabled language, so
     * the question is checked against those instead -- otherwise a
     * department that restricted nothing could not narrow a question at
     * all.
     */
    const paper = await acceptedLanguagesFor(question.assessment.allowedLanguages);
    const outside = wanted.filter((key) => !paper.includes(key));
    if (outside.length > 0) {
      throw new ValidationError(
        `This paper is not answered in ${outside.map(paperLanguageLabel).join(", ")}. Add it to the paper's languages first, or pick from what the paper accepts — a question cannot accept a language the candidates were not told about.`,
      );
    }
    if (wanted.length === paper.length) {
      /**
       * Ticking every one of them is the same as ticking none, and
       * storing it would be a narrowing that silently stops narrowing the
       * day somebody adds a language to the paper.
       */
      throw new ValidationError(
        "That is every language this paper accepts, which is what a question with none ticked already allows. Clear them instead.",
      );
    }

    const before = normalisePaperLanguages(question.allowedLanguages);
    if (before.join(",") === wanted.join(",")) {
      throw new ConflictError("That is already what this question accepts.");
    }

    await db.assessmentProblem.update({ where: { id: question.id }, data: { allowedLanguages: wanted } });

    await audit({
      actorId: actor.id,
      action: "assessment.question_languages_changed",
      entityType: "AssessmentProblem",
      entityId: question.id,
      sensitivity: "SENSITIVE",
      metadata: {
        slug: question.assessment.slug,
        status: question.assessment.status,
        position: question.position,
        title: question.problemVersion.title,
        before,
        after: wanted,
      },
      ipHash: await requestIpHash(),
    });

    revalidatePath(`/admin/assessments/${question.assessment.id}`);
    return { languages: wanted };
  }, "setQuestionLanguages");
}

// ── Moderating a question after the paper ──────────────────────────────

const moderationSchema = z
  .object({
    assessmentId: idSchema,
    kind: z.enum(["coding", "mcq"]),
    questionId: idSchema,
    moderation: z.enum(QUESTION_MODERATIONS),
    reason: z
      .string()
      .trim()
      .min(5, "Give a reason of at least 5 characters — it is recorded, and a candidate may ask.")
      .max(500, "Keep the reason under 500 characters."),
  })
  .strict();
export type SetQuestionModerationInput = z.input<typeof moderationSchema>;

/**
 * Award a question to everyone, withdraw it from the paper, or undo
 * either (Phase 13i).
 *
 * The remedy an examiner needs when a question turns out to be wrong
 * after a cohort has answered it. What each one does to the arithmetic is
 * in `packages/shared/src/exam-moderation.ts`, where it can be read
 * without a database; this is the authority, the record and the refusals.
 *
 *   - **A reason is always required**, including for undoing. A mark that
 *     moved with nothing recorded is a mark nobody can explain to the
 *     candidate who lost it. For a moderated question it is stored on the
 *     row as well, because staff reading the results months later cannot
 *     read the audit log (`tests/repo/admin-scope.test.ts` R5) and should
 *     not have to.
 *   - **Allowed while the paper is still open.** Spotting a broken
 *     question mid-exam and taking it out at once is better for every
 *     candidate than letting the rest of the hall answer it. Nothing a
 *     candidate can see changes: marks are not shown during a sitting.
 *   - **Not allowed on a question of another paper**, even a real one —
 *     the id is checked against the assessment rather than trusted.
 *
 * Audited at SENSITIVE: it changes marks, which is the definition of a
 * sensitive act on this surface. Whether the results had already been
 * released is in the row, since that is the detail that decides whether
 * anybody had read the old mark.
 */
export async function setQuestionModeration(
  input: SetQuestionModerationInput,
): Promise<ActionResult<{ moderation: QuestionModeration }>> {
  return runAction(async () => {
    const actor = await requireActionRole("ADMIN", "SUPER_ADMIN");
    const parsed = moderationSchema.parse(input);
    const assessment = await db.assessment.findUnique({
      where: { id: parsed.assessmentId },
      select: { id: true, slug: true, status: true, resultsPublishedAt: true },
    });
    if (!assessment) throw new NotFoundError("That assessment was not found.");

    const now = new Date();
    const moderated = parsed.moderation !== "NONE";
    /**
     * NONE stores no reason, no stamp: the CHECK on both tables refuses
     * the half-states, so the two halves of this object have to agree.
     * The reason still reaches the audit row.
     */
    const data = moderated
      ? {
          moderation: parsed.moderation,
          moderationReason: parsed.reason,
          moderatedById: actor.id,
          moderatedAt: now,
        }
      : { moderation: "NONE" as const, moderationReason: null, moderatedById: null, moderatedAt: null };

    const where = { id: parsed.questionId, assessmentId: assessment.id };
    const previous =
      parsed.kind === "coding"
        ? await db.assessmentProblem.findFirst({
            where,
            select: { id: true, position: true, moderation: true },
          })
        : await db.assessmentMcq.findFirst({
            where,
            select: { id: true, position: true, moderation: true },
          });
    if (!previous) throw new NotFoundError("That question is not on this paper.");
    if (previous.moderation === parsed.moderation) {
      throw new ValidationError(
        parsed.moderation === "NONE"
          ? "That question is not moderated."
          : "That question already carries exactly this moderation.",
      );
    }

    const moved =
      parsed.kind === "coding"
        ? await db.assessmentProblem.updateMany({ where, data })
        : await db.assessmentMcq.updateMany({ where, data });
    if (moved.count !== 1) {
      throw new AppError("That question changed a moment ago. Refresh the page and try again.", 409);
    }

    await audit({
      actorId: actor.id,
      action: "assessment.question.moderated",
      entityType: parsed.kind === "coding" ? "AssessmentProblem" : "AssessmentMcq",
      entityId: parsed.questionId,
      sensitivity: "SENSITIVE",
      metadata: {
        assessmentId: assessment.id,
        slug: assessment.slug,
        position: previous.position,
        from: previous.moderation,
        to: parsed.moderation,
        reason: parsed.reason,
        resultsWereReleased: assessment.resultsPublishedAt !== null,
      },
      ipHash: await requestIpHash(),
    });

    revalidatePath(`/admin/assessments/${assessment.id}`);
    revalidatePath(`/admin/assessments/${assessment.id}/results`);
    return { moderation: parsed.moderation };
  }, "setQuestionModeration");
}

// ── Reusing a paper ────────────────────────────────────────────────────

const duplicateSchema = z
  .object({
    assessmentId: idSchema,
    slug: z
      .string()
      .trim()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lower-case words joined by hyphens, e.g. cse-2027-midsem-b.")
      .max(80),
    title: z.string().trim().min(1, "Give the copy a title.").max(ASSESSMENT_LIMITS.title.max),
    opensAt: dateFromInput("opening time"),
    closesAt: dateFromInput("closing time"),
  })
  .superRefine((value, ctx) => {
    if (value.closesAt <= value.opensAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["closesAt"],
        message: "The assessment must close after it opens.",
      });
    }
  });
export type DuplicateAssessmentInput = z.input<typeof duplicateSchema>;

/**
 * Copy a paper, questions and all, into a new DRAFT (Phase 13l).
 *
 * The commonest thing a department does with an assessment is set it
 * again: the same paper for the other section, the same mid-semester test
 * for next year's batch, a re-sit for the people who missed it. Until now
 * that meant re-authoring it by hand — every pinned problem looked up
 * again by address, every multiple-choice question retyped with its
 * options in order and its answer line — which is slow and, worse, is the
 * kind of slow that produces a paper subtly different from the one it was
 * meant to match.
 *
 * What is copied: the terms, the watching knobs, the audience, the
 * accepted languages, and every question at THE SAME PINNED REVISION,
 * with its points, its position and its own language narrowing. The copy
 * asks the same questions as the original, which is the point.
 *
 * What is NOT copied, each for a reason:
 *
 *   - **The status.** A copy is a DRAFT. Publishing is a decision, and a
 *     paper that opened itself because its original was open would be a
 *     paper nobody meant to set.
 *   - **The window.** Required, and new: a copy carrying the original's
 *     window is a paper that already closed.
 *   - **Any moderation.** Awarding a question to everyone or withdrawing
 *     it was a decision about one sitting of one cohort. Carrying it over
 *     would silently annul a question for a cohort that has not sat it.
 *   - **The halls.** A hall is a room, a clock and a network allowlist;
 *     the copy is for a different time and usually a different room, and
 *     an inherited CIDR allowlist is a lab door left open.
 *   - **The Safe Exam Browser keys.** They are a secret for one paper,
 *     and copying a secret quietly is how it ends up somewhere nobody
 *     chose to put it.
 *   - **Everything a sitting produced**: attempts, marks, whether the
 *     results were released.
 *
 * One transaction, so a copy is whole or is not there at all — a
 * half-copied paper is worse than none, because somebody would publish
 * it.
 */
export async function duplicateAssessment(
  input: DuplicateAssessmentInput,
): Promise<ActionResult<{ id: string; slug: string; questions: number }>> {
  return runAction(async () => {
    const actor = await requireActionRole("ADMIN", "SUPER_ADMIN");
    const parsed = duplicateSchema.parse(input);

    const source = await db.assessment.findUnique({
      where: { id: parsed.assessmentId },
      select: {
        id: true,
        slug: true,
        instructions: true,
        proctorMode: true,
        affectsPlacementEligibility: true,
        durationSec: true,
        maxAttempts: true,
        maxFocusWarnings: true,
        onLimit: true,
        strictMode: true,
        refuseOutsidePaste: true,
        sitInPopup: true,
        allowedLanguages: true,
        audienceBatchYear: true,
        audienceDepartmentCode: true,
        audienceSection: true,
        problems: {
          orderBy: { position: "asc" },
          select: { position: true, points: true, problemVersionId: true, allowedLanguages: true },
        },
        mcqs: {
          orderBy: { position: "asc" },
          select: { position: true, points: true, stem: true, options: true, correctIndex: true, explanation: true },
        },
      },
    });
    if (!source) throw new NotFoundError("That assessment was not found.");

    const taken = await db.assessment.findUnique({ where: { slug: parsed.slug }, select: { id: true } });
    if (taken) throw new ConflictError("An assessment already uses that address.");

    const copy = await db.$transaction(async (tx) => {
      const created = await tx.assessment.create({
        data: {
          slug: parsed.slug,
          title: parsed.title,
          opensAt: parsed.opensAt,
          closesAt: parsed.closesAt,
          // A copy is always a draft; see the comment above.
          status: "DRAFT",
          instructions: source.instructions,
          proctorMode: source.proctorMode,
          affectsPlacementEligibility: source.affectsPlacementEligibility,
          durationSec: source.durationSec,
          maxAttempts: source.maxAttempts,
          maxFocusWarnings: source.maxFocusWarnings,
          onLimit: source.onLimit,
          strictMode: source.strictMode,
          refuseOutsidePaste: source.refuseOutsidePaste,
          sitInPopup: source.sitInPopup,
          allowedLanguages: source.allowedLanguages,
          audienceBatchYear: source.audienceBatchYear,
          audienceDepartmentCode: source.audienceDepartmentCode,
          audienceSection: source.audienceSection,
          createdById: actor.id,
        },
        select: { id: true, slug: true },
      });

      /**
       * The SAME pinned revision, not the problem's current one. A copy
       * set for the other section must ask exactly what the first section
       * was asked, and `AssessmentProblem` refuses an unfrozen version
       * anyway (`AssessmentProblem_frozen_check`).
       */
      if (source.problems.length > 0) {
        await tx.assessmentProblem.createMany({
          data: source.problems.map((problem) => ({
            assessmentId: created.id,
            problemVersionId: problem.problemVersionId,
            position: problem.position,
            points: problem.points,
            allowedLanguages: problem.allowedLanguages,
          })),
        });
      }
      if (source.mcqs.length > 0) {
        await tx.assessmentMcq.createMany({
          data: source.mcqs.map((mcq) => ({
            assessmentId: created.id,
            position: mcq.position,
            points: mcq.points,
            stem: mcq.stem,
            options: mcq.options,
            correctIndex: mcq.correctIndex,
            explanation: mcq.explanation,
          })),
        });
      }
      return created;
    });

    const questions = source.problems.length + source.mcqs.length;
    await audit({
      actorId: actor.id,
      action: "assessment.created",
      entityType: "Assessment",
      entityId: copy.id,
      sensitivity: "SENSITIVE",
      metadata: {
        slug: copy.slug,
        via: "duplicate",
        copiedFrom: source.id,
        copiedFromSlug: source.slug,
        questions,
        proctorMode: source.proctorMode,
        placement: String(source.affectsPlacementEligibility),
      },
      ipHash: await requestIpHash(),
    });
    revalidatePath("/admin/assessments");
    return { id: copy.id, slug: copy.slug, questions };
  }, "duplicateAssessment");
}
