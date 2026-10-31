import "server-only";
import type { DbTx } from "@recx/db";
import { INTERVIEW_PENDING_LIMIT, INTERVIEW_REFUSALS } from "@recx/shared";
import { db } from "@/lib/db";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { decideExperienceSchema, submitExperienceSchema, withdrawExperienceSchema } from "@/lib/interviews/schema";

/**
 * The interview archive's writes (Phase 12e).
 *
 * The part worth reading twice is `applyCompanyTags`. SPEC §4(d) says a
 * derived number is maintained, never computed on read, and "asked at"
 * frequency is the most derived number in the product: it is a count over
 * approved accounts of interviews, shown on a page a student uses to
 * decide what to revise. So it moves in the same transaction as the
 * decision that changes it, in both directions — approving increments,
 * reversing an approval decrements — and a tag that reaches zero is
 * deleted rather than left as a company claiming a problem nobody
 * reported.
 */

export interface ExperienceId {
  id: string;
}

export async function submitExperienceFor(userId: string, input: unknown): Promise<ExperienceId> {
  const parsed = submitExperienceSchema.parse(input);

  const now = new Date();
  const year = Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric" }).format(now));
  if (parsed.heldYear > year) throw new ValidationError(INTERVIEW_REFUSALS.futureYear);

  /**
   * A cap on what one person can leave in somebody else's queue. Not a
   * rate limit dressed up: a moderator reads these, and three waiting from
   * one student is already more than a fair share of that attention.
   */
  const waiting = await db.interviewExperience.count({ where: { authorId: userId, status: "PENDING" } });
  if (waiting >= INTERVIEW_PENDING_LIMIT) throw new ValidationError(INTERVIEW_REFUSALS.pendingLimit);

  /**
   * Only PUBLISHED problems may be named. A draft problem's id in a
   * submission would be a way to learn that it exists, and an archive row
   * pointing at one would surface it the day it is published.
   */
  const problems = parsed.problemIds.length
    ? await db.problem.findMany({
        where: { id: { in: parsed.problemIds }, status: "PUBLISHED" },
        select: { id: true },
      })
    : [];
  if (problems.length !== parsed.problemIds.length) {
    throw new ValidationError("Name problems from the catalogue; one of those is not there.");
  }

  // A company that already exists is linked now; one that does not is left
  // for the moderator to decide at approval time, because creating a
  // company from a free-text field is how a catalogue ends up with
  // "Zoho", "zoho corp" and "ZOHO".
  const slug = slugify(parsed.companyName);
  const company = slug ? await db.company.findUnique({ where: { slug }, select: { id: true } }) : null;

  const created = await db.interviewExperience.create({
    data: {
      authorId: userId,
      source: "STUDENT",
      companyId: company?.id ?? null,
      companyName: parsed.companyName,
      role: parsed.role,
      mode: parsed.mode,
      heldYear: parsed.heldYear,
      heldMonth: parsed.heldMonth,
      rounds: parsed.rounds,
      longestRoundMinutes: parsed.longestRoundMinutes,
      outcome: parsed.outcome,
      roundKinds: parsed.roundKinds,
      topics: parsed.topics,
      preparation: parsed.preparation,
      problems: { createMany: { data: problems.map((p) => ({ problemId: p.id })) } },
    },
    select: { id: true },
  });
  return created;
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export interface DecisionResult {
  id: string;
  approved: boolean;
  authorId: string | null;
  companyId: string | null;
  /** Problems whose company tag moved, for the audit row. */
  problemsTagged: number;
}

/**
 * Approve or reject, and move the company tags to match — in one
 * transaction with the decision, in both directions.
 */
export async function decideExperienceAs(moderatorId: string, input: unknown): Promise<DecisionResult> {
  const { experienceId, approve, reason, companyId, createCompany } = decideExperienceSchema.parse(input);

  return db.$transaction(async (tx) => {
    const experience = await tx.interviewExperience.findUnique({
      where: { id: experienceId },
      select: {
        id: true,
        status: true,
        authorId: true,
        companyId: true,
        companyName: true,
        problems: { select: { problemId: true } },
      },
    });
    if (!experience) throw new NotFoundError("That experience was not found.");

    const wasCounted = experience.status === "APPROVED";
    let company = companyId ?? experience.companyId;
    if (companyId) {
      const row = await tx.company.findUnique({ where: { id: companyId }, select: { id: true } });
      if (!row) throw new ValidationError("That company is not in the catalogue.");
    }
    if (createCompany && approve) {
      const slug = slugify(experience.companyName);
      if (!slug) throw new ValidationError("That company name cannot become a catalogue entry. Pick one instead.");
      // `curated: false` — this company exists because a student reported
      // an interview at it, which is exactly what the flag is for.
      const made = await tx.company.upsert({
        where: { slug },
        create: { slug, name: experience.companyName, curated: false },
        update: {},
        select: { id: true },
      });
      company = made.id;
    }
    if (!approve) company = experience.companyId;

    if (wasCounted === approve && experience.status !== "PENDING") {
      throw new ValidationError(INTERVIEW_REFUSALS.alreadyDecided);
    }

    await tx.interviewExperience.update({
      where: { id: experience.id },
      data: {
        status: approve ? "APPROVED" : "REJECTED",
        companyId: company,
        decidedById: moderatorId,
        decidedAt: new Date(),
        decisionReason: reason,
      },
    });

    const problemIds = experience.problems.map((p) => p.problemId);
    let moved = 0;
    if (company && problemIds.length > 0) {
      if (approve && !wasCounted) moved = await applyCompanyTags(tx, company, problemIds, 1);
      else if (!approve && wasCounted) moved = await applyCompanyTags(tx, experience.companyId!, problemIds, -1);
    }

    return { id: experience.id, approved: approve, authorId: experience.authorId, companyId: company, problemsTagged: moved };
  });
}

/**
 * Move one company's "asked at" counts by `delta`, and keep the source
 * honest.
 *
 * A tag that exists because the placement cell curated it keeps saying so
 * until a real interview reports the same problem; from then on it is
 * EXPERIENCE, because that is what a student reading the label needs to
 * know. A count that falls to zero removes the tag rather than leaving a
 * company claiming a problem nobody reported.
 */
export async function applyCompanyTags(
  tx: DbTx,
  companyId: string,
  problemIds: readonly string[],
  delta: 1 | -1,
): Promise<number> {
  let moved = 0;
  for (const problemId of problemIds) {
    const key = { problemId_companyId: { problemId, companyId } };
    const existing = await tx.problemCompanyTag.findUnique({ where: key, select: { frequency: true } });
    if (!existing) {
      // Nothing to take away from.
      if (delta < 0) continue;
      await tx.problemCompanyTag.create({ data: { problemId, companyId, frequency: 1, source: "EXPERIENCE" } });
      moved += 1;
      continue;
    }
    const next = existing.frequency + delta;
    if (next <= 0) {
      await tx.problemCompanyTag.delete({ where: key });
    } else {
      await tx.problemCompanyTag.update({ where: key, data: { frequency: next, source: "EXPERIENCE" } });
    }
    moved += 1;
  }
  return moved;
}

/** A student withdrawing their own submission before anybody has read it. */
export async function withdrawExperienceFor(userId: string, input: unknown): Promise<ExperienceId> {
  const { experienceId } = withdrawExperienceSchema.parse(input);
  const experience = await db.interviewExperience.findUnique({
    where: { id: experienceId },
    select: { id: true, authorId: true, status: true },
  });
  if (!experience) throw new NotFoundError("That experience was not found.");
  if (experience.authorId !== userId) throw new ForbiddenError(INTERVIEW_REFUSALS.notYours);
  if (experience.status !== "PENDING") throw new ValidationError(INTERVIEW_REFUSALS.alreadyDecided);

  // Deleted, not hidden — the opposite of a discussion post, and for the
  // opposite reason. Nobody has read it, nothing is built on it, and the
  // student is withdrawing their own account of their own interview.
  await db.interviewExperience.delete({ where: { id: experience.id } });
  return { id: experience.id };
}
