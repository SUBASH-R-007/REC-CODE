import "server-only";
import { bootstrapRowKey, type BootstrapRow } from "@recx/shared";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { ValidationError } from "@/lib/errors";
import { slugify } from "@/lib/interviews/archive";
import { submitExperienceSchema } from "@/lib/interviews/schema";

/**
 * Writing the pre-launch interview archive (Phase 16q, `docs/ROADMAP.md`
 * §1.7).
 *
 * `submitExperienceFor` is the student's own form and cannot be reused for
 * this, for three reasons that are each the point of it:
 *
 *   * it writes `source: "STUDENT"` and an `authorId`, and a bootstrap row
 *     has neither — `InterviewExperience_author_check` was written to allow
 *     exactly that;
 *   * it enforces `INTERVIEW_PENDING_LIMIT`, three waiting per author,
 *     because a moderator's attention is finite. A bootstrap of sixty rows
 *     is one deliberate act by a member of staff, not sixty students each
 *     taking more than their share;
 *   * it is reached from a session, and this is reached from a file.
 *
 * Everything else is shared on purpose: the same `submitExperienceSchema`,
 * so a bootstrap row cannot carry a value a student's row could not; the
 * same "PUBLISHED problems only" rule; the same company-linking rule, which
 * links a company that already exists and leaves one that does not to the
 * moderator, because creating a company from a free-text field is how a
 * catalogue ends up with "Zoho", "zoho corp" and "ZOHO".
 *
 * And the row arrives **PENDING**, like every other. §1.7's "done when"
 * has two halves — collected, and *"the moderation queue has been worked
 * through once"* — and an import that approved its own rows would quietly
 * delete the second half. Nothing here can approve anything;
 * `decideExperienceAs` is the only thing that can, and it needs a person.
 */

export interface BootstrapOutcome {
  id: string | null;
  /** Set when the row was already in the archive; `id` is then null. */
  duplicateOf?: string;
  /** Set when the row was refused; `id` is then null. */
  refusal?: string;
}

/**
 * One row, in one transaction. A file of three hundred is three hundred
 * transactions, so a bad row on line 180 never discards the 179 before it —
 * the same rule the aptitude import follows, for the same reason.
 */
export async function bootstrapExperience(args: {
  operatorId: string;
  row: BootstrapRow;
  /** The campus year, so a row held "this year" is refused consistently. */
  nowYear: number;
}): Promise<BootstrapOutcome> {
  const { operatorId, row } = args;

  const parsed = submitExperienceSchema.safeParse({
    companyName: row.companyName,
    role: row.role,
    mode: row.mode,
    heldYear: row.heldYear,
    heldMonth: row.heldMonth,
    rounds: row.rounds,
    longestRoundMinutes: row.longestRoundMinutes,
    outcome: row.outcome,
    roundKinds: row.roundKinds,
    topics: row.topics,
    preparation: row.preparation,
    problemIds: [],
  });
  if (!parsed.success) {
    return { id: null, refusal: parsed.error.issues.map((issue) => issue.message).join("; ") };
  }
  if (row.heldYear > args.nowYear) return { id: null, refusal: "the interview is in the future" };

  /**
   * Addresses, not ids, and PUBLISHED only — the same rule the student's
   * form applies, and for the same reason: a draft problem's id in an
   * archive row would surface it the day it is published.
   */
  const problems = row.problemSlugs.length
    ? await db.problem.findMany({
        where: { slug: { in: row.problemSlugs }, status: "PUBLISHED" },
        select: { id: true, slug: true },
      })
    : [];
  if (problems.length !== row.problemSlugs.length) {
    const found = new Set(problems.map((p) => p.slug));
    const missing = row.problemSlugs.filter((slug) => !found.has(slug));
    return { id: null, refusal: `not published problems in the catalogue: ${missing.join(", ")}` };
  }

  const slug = slugify(row.companyName);
  const company = slug ? await db.company.findUnique({ where: { slug }, select: { id: true } }) : null;

  /**
   * Re-running the import must not double a company tag. The key is
   * company, role, month and outcome — see `bootstrapRowKey` for why it is
   * not the whole row — and it is matched against BOOTSTRAP rows only, so a
   * student who later writes up the same interview is still a second
   * account of it rather than a duplicate of staff's.
   */
  const key = bootstrapRowKey(row);
  const existing = await db.interviewExperience.findMany({
    where: {
      source: "BOOTSTRAP",
      heldYear: row.heldYear,
      heldMonth: row.heldMonth,
      outcome: row.outcome,
    },
    select: { id: true, companyName: true, role: true, heldYear: true, heldMonth: true, outcome: true },
  });
  const already = existing.find((candidate) => bootstrapRowKey(candidate) === key);
  if (already) return { id: null, duplicateOf: already.id };

  const created = await db.$transaction(async (tx) => {
    const made = await tx.interviewExperience.create({
      data: {
        authorId: null,
        source: "BOOTSTRAP",
        companyId: company?.id ?? null,
        companyName: row.companyName,
        role: row.role,
        mode: row.mode,
        heldYear: row.heldYear,
        heldMonth: row.heldMonth,
        rounds: row.rounds,
        longestRoundMinutes: row.longestRoundMinutes,
        outcome: row.outcome,
        roundKinds: row.roundKinds,
        topics: row.topics,
        preparation: row.preparation,
        problems: { createMany: { data: problems.map((p) => ({ problemId: p.id })) } },
      },
      select: { id: true },
    });
    return made;
  });

  /**
   * Audited to the operator, because a row with no author would otherwise
   * be an account of an interview that nobody in the system is answerable
   * for. The company and the month are recorded; nothing about a person is,
   * because a bootstrap row is deliberately not about one.
   */
  await audit({
    actorId: operatorId,
    action: "interview.bootstrap.create",
    entityType: "InterviewExperience",
    entityId: created.id,
    sensitivity: "NORMAL",
    metadata: { companyName: row.companyName, heldYear: row.heldYear, heldMonth: row.heldMonth },
  });

  return { id: created.id };
}

/** The operator a CLI import is recorded under: an ADMIN or SUPER_ADMIN, by college id. */
export async function bootstrapOperator(collegeId: string): Promise<{ id: string; collegeId: string }> {
  const user = await db.user.findFirst({
    where: { collegeId, role: { in: ["ADMIN", "SUPER_ADMIN"] }, status: "ACTIVE" },
    select: { id: true, collegeId: true },
  });
  if (!user) throw new ValidationError(`${collegeId} is not an active ADMIN or SUPER_ADMIN`);
  return user;
}
