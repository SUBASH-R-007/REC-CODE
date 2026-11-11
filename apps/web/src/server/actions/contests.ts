"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { requireActionUser } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { ConflictError, NotFoundError, ValidationError, runAction, type ActionResult } from "@/lib/errors";
import { requestIpHash } from "@/lib/ip";

/**
 * A student's own contest actions (Phase 5): register for a contest, and
 * start a virtual run of a finished one.
 *
 * Both are the student acting on themselves, so the guard is
 * requireActionUser() — there is no staff capability here. A SOFT_RESTRICTED
 * account may not register (SPEC §5 and the Phase 8 design: a soft
 * restriction blocks contest registration but never blocks solving).
 */

const slugSchema = z.object({
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "That is not a contest."),
});
export type ContestSlugInput = z.input<typeof slugSchema>;

/** PUBLIC, or COHORT matching the student's own cohort. */
function audienceWhere(user: { batchYear: number | null; departmentCode: string | null }) {
  return {
    OR: [
      { visibility: "PUBLIC" as const },
      {
        visibility: "COHORT" as const,
        AND: [
          { OR: [{ audienceBatchYear: null }, { audienceBatchYear: user.batchYear }] },
          { OR: [{ audienceDepartmentCode: null }, { audienceDepartmentCode: user.departmentCode }] },
        ],
      },
    ],
  };
}

export async function registerForContest(input: ContestSlugInput): Promise<ActionResult<{ kind: string }>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const parsed = slugSchema.parse(input);

    if (user.status === "SOFT_RESTRICTED") {
      throw new ValidationError(
        "Your account is restricted for inactivity. Solve a problem to clear it, then register.",
      );
    }

    const contest = await db.contest.findFirst({
      where: { slug: parsed.slug, status: { in: ["PUBLISHED", "RUNNING"] }, ...audienceWhere(user) },
      select: { id: true, isRated: true, endsAt: true },
    });
    if (!contest) throw new NotFoundError("That contest is not open for registration.");
    if (contest.endsAt <= new Date()) throw new ValidationError("That contest has finished.");

    // A rated contest is entered RATED; an unrated one UNRATED. The two are
    // different registration kinds, so the board and the rating field can
    // both be read without re-deriving who counted.
    const kind = contest.isRated ? "RATED" : "UNRATED";
    try {
      await db.contestRegistration.create({ data: { contestId: contest.id, userId: user.id, kind } });
    } catch {
      throw new ConflictError("You are already registered for that contest.");
    }

    await audit({
      actorId: user.id,
      action: "contest.registered",
      entityType: "Contest",
      entityId: contest.id,
      sensitivity: "NORMAL",
      metadata: { kind },
      ipHash: await requestIpHash(),
    });
    revalidatePath("/contests");
    revalidatePath(`/contests/${parsed.slug}`);
    return { kind };
  }, "registerForContest");
}

/**
 * Start a virtual run: the contest's clock is replayed from now, unrated and
 * excluded from standings (SPEC §5). Only a finished contest can be run
 * virtually — a live one is simply entered.
 */
export async function startVirtualContest(input: ContestSlugInput): Promise<ActionResult<{ startsAt: Date }>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const parsed = slugSchema.parse(input);

    const contest = await db.contest.findFirst({
      where: { slug: parsed.slug, status: { in: ["FINISHED", "RATED"] }, ...audienceWhere(user) },
      select: { id: true, endsAt: true },
    });
    if (!contest) throw new NotFoundError("That contest cannot be run virtually yet.");

    const existingLive = await db.contestRegistration.findFirst({
      where: { contestId: contest.id, userId: user.id, kind: { in: ["RATED", "UNRATED"] } },
      select: { id: true },
    });
    if (existingLive) {
      throw new ConflictError("You took part in this contest live, so there is nothing to replay.");
    }

    const startsAt = new Date();
    try {
      await db.contestRegistration.create({
        data: { contestId: contest.id, userId: user.id, kind: "VIRTUAL", virtualStartsAt: startsAt },
      });
    } catch {
      throw new ConflictError("You have already started a virtual run of this contest.");
    }

    await audit({
      actorId: user.id,
      action: "contest.virtual_started",
      entityType: "Contest",
      entityId: contest.id,
      sensitivity: "NORMAL",
      metadata: { startsAt: startsAt.toISOString() },
      ipHash: await requestIpHash(),
    });
    revalidatePath(`/contests/${parsed.slug}`);
    return { startsAt };
  }, "startVirtualContest");
}
