import type { DbTx } from "@recx/db";

/**
 * ACTIVE SUPER_ADMIN accounts, counted under one transaction-scoped advisory
 * lock. Every role or status change that can remove a super-admin (the
 * role action, the status actions and the BULK_STATUS_CHANGE executor) counts
 * through this, so two concurrent changes are serialised. Without it, two
 * super-admins demoting each other each lock only their own target row, each
 * count two, and both commit, leaving none. The lock is taken before the
 * count and held until the transaction ends.
 */
export async function countActiveSuperAdminsLocked(tx: DbTx): Promise<number> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('super-admin-set'))`;
  return tx.user.count({ where: { role: "SUPER_ADMIN", status: "ACTIVE" } });
}
