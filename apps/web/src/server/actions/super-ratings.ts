"use server";

import { revalidatePath } from "next/cache";
import {
  computeRatingChanges,
  MIN_RATED_PARTICIPANTS,
  PROVISIONAL_CONTESTS,
  RATING_SEED,
  type RatingParticipant,
} from "@recx/shared";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { ConflictError, NotFoundError, ValidationError, runAction, type ActionResult } from "@/lib/errors";
import { requestIpHash } from "@/lib/ip";

/**
 * Release a finished contest's ratings (capability "ratings.manage",
 * SUPER_ADMIN only).
 *
 * SPEC §5: "one transaction per contest, SELECT ... FOR UPDATE on the
 * Contest row, abort if ratingComputedAt IS NOT NULL, store seed on every
 * RatingChange so a dispute is reconstructable".
 *
 * Idempotence is therefore structural, and belt-and-braces: this action
 * takes the row lock and aborts on a second run, and the database refuses to
 * rewrite ratingComputedAt anyway (Contest_rating_once). Running it twice
 * changes nothing and is a gate test.
 *
 * The arithmetic is entirely in @recx/shared (rating.ts) — pure, so the same
 * field always produces the same deltas, and a dispute can be recomputed
 * from the stored `seed` and `before` years later.
 *
 * Ranks come from ContestStanding, which the rank job materialises from
 * ContestProblemAttempt. A contest whose board has not been ranked yet is
 * refused rather than rated on a half-built field.
 */

const releaseSchema = z.object({
  contestId: z.string().trim().min(1, "Name the contest."),
});
export type ReleaseContestRatingInput = z.input<typeof releaseSchema>;

interface ReleaseResult {
  rated: number;
  contestId: string;
}

export async function releaseContestRating(
  input: ReleaseContestRatingInput,
): Promise<ActionResult<ReleaseResult>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const parsed = releaseSchema.parse(input);

    const result = await db.$transaction(async (tx) => {
      // The row lock is what makes two concurrent releases safe: the second
      // waits, then sees ratingComputedAt set and aborts.
      const locked = await tx.$queryRaw<Array<{ id: string; status: string; isRated: boolean; endsAt: Date; ratingComputedAt: Date | null }>>`
        SELECT "id", "status"::text AS status, "isRated", "endsAt", "ratingComputedAt"
          FROM "Contest"
         WHERE "id" = ${parsed.contestId}
           FOR UPDATE`;
      const contest = locked[0];
      if (!contest) throw new NotFoundError("That contest was not found.");
      if (contest.ratingComputedAt !== null) {
        throw new ConflictError("This contest has already been rated. A rating is computed once and is then final.");
      }
      if (!contest.isRated) throw new ValidationError("This contest was announced as unrated.");
      if (contest.status !== "FINISHED") {
        throw new ValidationError("Only a finished contest can be rated.");
      }

      // The rated field: live RATED entries only. VIRTUAL replays and
      // UNRATED entries are excluded from standings and from rating.
      const rows = await tx.contestStanding.findMany({
        where: {
          contestId: contest.id,
          user: { contestRegistrations: { some: { contestId: contest.id, kind: "RATED" } } },
        },
        select: { userId: true, rank: true },
        orderBy: [{ score: "desc" }, { penalty: "asc" }, { userId: "asc" }],
      });
      if (rows.some((r) => r.rank === null)) {
        throw new ConflictError("The standings have not been ranked yet. Wait for the rank job, then release again.");
      }
      if (rows.length < MIN_RATED_PARTICIPANTS) {
        throw new ValidationError(
          `A rated contest needs at least ${MIN_RATED_PARTICIPANTS} rated participants; this one had ${rows.length}.`,
        );
      }

      const existing = await tx.userRating.findMany({
        where: { userId: { in: rows.map((r) => r.userId) } },
        select: { userId: true, rating: true, contestsRated: true },
      });
      const ratingOf = new Map(existing.map((r) => [r.userId, r.rating]));
      const countOf = new Map(existing.map((r) => [r.userId, r.contestsRated]));

      const participants: RatingParticipant[] = rows.map((r) => ({
        userId: r.userId,
        rating: ratingOf.get(r.userId) ?? RATING_SEED,
        rank: r.rank!,
      }));
      const changes = computeRatingChanges(participants);
      const computedAt = new Date();

      await tx.ratingChange.createMany({
        data: changes.map((c) => ({
          contestId: contest.id,
          userId: c.userId,
          before: c.before,
          after: c.after,
          delta: c.delta,
          rank: c.rank,
          seed: c.seed,
          ratedCount: changes.length,
          computedAt,
        })),
      });

      for (const c of changes) {
        await tx.userRating.upsert({
          where: { userId: c.userId },
          create: {
            userId: c.userId,
            rating: c.after,
            contestsRated: 1,
            lastRatedAt: computedAt,
          },
          update: {
            rating: c.after,
            contestsRated: (countOf.get(c.userId) ?? 0) + 1,
            lastRatedAt: computedAt,
          },
        });
      }

      // ratingComputedAt and ratedParticipants are written together; the
      // database refuses any later change to either (Contest_rating_once).
      await tx.contest.update({
        where: { id: contest.id },
        data: { status: "RATED", ratingComputedAt: computedAt, ratedParticipants: changes.length },
      });

      return { rated: changes.length, contestId: contest.id };
    });

    await audit({
      actorId: actor.id,
      action: "contest.rating_released",
      entityType: "Contest",
      entityId: result.contestId,
      sensitivity: "SECURITY",
      metadata: {
        rated: String(result.rated),
        provisionalAfter: String(PROVISIONAL_CONTESTS),
      },
      ipHash: await requestIpHash(),
    });
    revalidatePath("/super");
    revalidatePath(`/contests`);
    return result;
  }, "releaseContestRating");
}
