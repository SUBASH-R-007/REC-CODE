import { DEFAULT_INACTIVITY_POLICY, inactivityPolicySchema } from "@recx/shared";
import type { Db } from "@recx/db";

/**
 * Seeding the global inactivity policy (Phase 8b).
 *
 * One row, the shipped default, global scope, active — because
 * `resolveInactivityPolicy()` returns null when nothing is active and the
 * sweep then does nothing at all. That is the right answer in production for
 * a college that has configured none; in a dev database it means the whole
 * policy engine is a silent no-op and nobody developing against it would see
 * a transition.
 *
 * Idempotent, and it never writes a second version: the row is immutable by
 * trigger, so a re-seed that tried to "update the defaults" would crash. If a
 * global policy already exists the seed leaves it alone and says so — a
 * seeder that overwrote a threshold somebody had deliberately tuned would be
 * a seeder that quietly changed who gets restricted.
 */

export interface PolicySeedResult {
  readonly action: "created" | "left-alone";
  readonly version: number;
  readonly autoDisableEnabled: boolean;
}

export async function syncSeededInactivityPolicy(db: Db, createdById: string): Promise<PolicySeedResult> {
  const existing = await db.inactivityPolicy.findFirst({
    where: { batchYear: null, departmentCode: null },
    orderBy: { version: "desc" },
    select: { version: true, autoDisableEnabled: true },
  });
  if (existing) {
    return { action: "left-alone", version: existing.version, autoDisableEnabled: existing.autoDisableEnabled };
  }

  // The same gate the settings form goes through: a seed the form would
  // refuse is a seed nobody should be able to insert either.
  const parsed = inactivityPolicySchema.safeParse(DEFAULT_INACTIVITY_POLICY);
  if (!parsed.success) {
    throw new Error(
      `DEFAULT_INACTIVITY_POLICY does not satisfy inactivityPolicySchema: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")} ${issue.message}`)
        .join("; ")}`,
    );
  }

  const created = await db.inactivityPolicy.create({
    data: {
      ...DEFAULT_INACTIVITY_POLICY,
      countsAsActivity: DEFAULT_INACTIVITY_POLICY.countsAsActivity as never,
      createdById,
    },
    select: { version: true, autoDisableEnabled: true },
  });
  return { action: "created", version: created.version, autoDisableEnabled: created.autoDisableEnabled };
}
