import "server-only";

import {
  RESTRICTION_EFFECTS,
  RESTRICTION_STAGE_LABEL,
  campusDay,
  canSelfClear,
  dormancyChip,
  resolveInactivityPolicy,
  countsAsActivitySchema,
  type DormancyChip,
  type InactivityPolicyShape,
  type RestrictionStage,
} from "@recx/shared";
import { db } from "@/lib/db";
import { termKeyOn } from "@/server/queries/calendar";

/**
 * A student's own account standing (Phase 8e).
 *
 * Everything here answers one question for one person: where do I stand, and
 * what do I do about it? So it returns the stage, the sentence, the way out,
 * and whether that way out is available — never a score, never a band, never
 * anything a recruiter could read as a judgement.
 */

export interface MyStanding {
  readonly stage: RestrictionStage;
  readonly stageLabel: string;
  readonly countedInactiveDays: number;
  readonly chip: DormancyChip;
  /** Can they restore it themselves right now, and if not, why not. */
  readonly selfClear: { readonly allowed: boolean; readonly reason: string };
  readonly blocks: typeof RESTRICTION_EFFECTS.blocks;
  readonly doesNotBlock: typeof RESTRICTION_EFFECTS.doesNotBlock;
  readonly lastEvaluatedAt: Date | null;
}

function shape(row: {
  countsAsActivity: unknown;
  [key: string]: unknown;
}): InactivityPolicyShape {
  return {
    ...(row as unknown as Omit<InactivityPolicyShape, "countsAsActivity">),
    countsAsActivity: countsAsActivitySchema.parse(row.countsAsActivity),
  };
}

/**
 * Where this student stands.
 *
 * `userId` is read from the session by the caller and used as a where clause;
 * there is no path here that takes somebody else's id.
 */
export async function myStanding(userId: string, now = new Date()): Promise<MyStanding> {
  const [user, restriction, policies] = await Promise.all([
    db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { batchYear: true, departmentCode: true },
    }),
    db.accountRestriction.findUnique({
      where: { userId },
      select: {
        stage: true,
        countedInactiveDays: true,
        lastEvaluatedAt: true,
        selfClearedCount: true,
        selfClearedTermKey: true,
      },
    }),
    db.inactivityPolicy.findMany({ where: { isActive: true } }),
  ]);

  const stage = restriction?.stage ?? "NONE";
  const countedInactiveDays = restriction?.countedInactiveDays ?? 0;
  const policy = resolveInactivityPolicy(policies.map(shape), {
    batchYear: user.batchYear,
    departmentCode: user.departmentCode,
  });

  const termKey = await termKeyOn(campusDay(now));
  const selfClear = canSelfClear({
    stage,
    selfClearedCount: restriction?.selfClearedCount ?? 0,
    selfClearedTermKey: restriction?.selfClearedTermKey ?? null,
    termKey,
  });

  return {
    stage,
    stageLabel: RESTRICTION_STAGE_LABEL[stage],
    countedInactiveDays,
    chip: dormancyChip({ stage, countedInactiveDays, policy }),
    selfClear,
    blocks: RESTRICTION_EFFECTS.blocks,
    doesNotBlock: RESTRICTION_EFFECTS.doesNotBlock,
    lastEvaluatedAt: restriction?.lastEvaluatedAt ?? null,
  };
}

/**
 * The student's own status history, most recent first.
 *
 * Their own history, in their own words where there are any — this is the
 * thing the spec means by "a disputed lockout must be explainable". A student
 * who cannot see what happened to them cannot dispute it.
 *
 * The evidence JSON is deliberately NOT returned. It carries excluded dates
 * and reasons, which are the right thing for a human reviewing a dispute and
 * the wrong thing to render as a wall of dates on somebody's own page. The
 * counted-day number and the reason sentence are what a student needs.
 */
export async function myStatusHistory(userId: string, limit = 20) {
  const rows = await db.accountStatusEvent.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      fromStage: true,
      toStage: true,
      source: true,
      reason: true,
      createdAt: true,
    },
  });
  return rows.map((row) => ({
    id: row.id.toString(),
    fromStage: row.fromStage,
    toStage: row.toStage,
    toStageLabel: RESTRICTION_STAGE_LABEL[row.toStage],
    /** Who or what did it, in words a student can read. */
    by:
      row.source === "INACTIVITY_SWEEP"
        ? "the inactivity policy"
        : row.source === "AUTO_CLEAR_ON_SOLVE"
          ? "a problem you solved"
          : row.source === "SELF_CLEAR"
            ? "you"
            : row.source === "LEAVE_REVERSAL"
              ? "leave that was approved afterwards"
              : "the placement cell",
    reason: row.reason,
    at: row.createdAt,
  }));
}
