"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { NotFoundError, ValidationError, runAction, type ActionResult } from "@/lib/errors";
import { requestIpHash } from "@/lib/ip";
import { purgeCutoff } from "@/lib/privileged/executors/submission-purge";
import { createPrivilegedOperation } from "@/lib/privileged/operations";
import { PII_EXPORT_COLUMNS, userFilterSchema, userFilterWhere } from "@/lib/privileged/payloads";
import { enforcePrivilegedRequestRate } from "@/lib/privileged/rate";
import { LEGAL_HOLD_MESSAGE, readRetention } from "@/lib/privileged/retention";

/**
 * Data operations, SUPER_ADMIN only, both two-person approved:
 *
 *   requestPiiExport       privileged.requested (SECURITY)   capability "pii.export"
 *   requestSubmissionPurge privileged.requested (SENSITIVE)  supporting action
 *
 * A PII export is never stored: after approval the requester downloads it
 * from GET /super/data/exports/[id] within 24 hours, at most 3 times, each
 * download audited. Only the minimised PII_EXPORT_COLUMNS can be chosen.
 */

const reasonSchema = z
  .string()
  .trim()
  .min(10, "Give a reason of at least 10 characters. It is recorded in the audit log.")
  .max(500, "Keep the reason under 500 characters.");

const piiSchema = z.object({
  filter: userFilterSchema,
  columns: z
    .array(z.enum(PII_EXPORT_COLUMNS))
    .min(1, "Choose at least one column.")
    .max(PII_EXPORT_COLUMNS.length)
    .transform((c) => PII_EXPORT_COLUMNS.filter((k) => c.includes(k))),
  reason: reasonSchema,
});
export type RequestPiiExportInput = z.input<typeof piiSchema>;

export async function requestPiiExport(
  input: RequestPiiExportInput,
): Promise<ActionResult<{ id: string; expiresAt: string; count: number }>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const parsed = piiSchema.parse(input);
    await enforcePrivilegedRequestRate(actor.id);
    const count = await db.user.count({ where: userFilterWhere(parsed.filter) });
    if (count === 0) throw new ValidationError("No account matches this filter.");
    const filterText = Object.entries(parsed.filter)
      .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("|") : String(v)}`)
      .join(", ");
    const op = await createPrivilegedOperation({
      kind: "PII_EXPORT",
      payload: { filter: parsed.filter, columns: parsed.columns },
      summary: `Export ${count} account(s) (${parsed.columns.join(", ")})${filterText ? ` where ${filterText}` : ""}`,
      affectedCount: count,
      reason: parsed.reason,
      actor,
    });
    revalidatePath("/super/data");
    return { id: op.id, expiresAt: op.expiresAt.toISOString(), count };
  }, "requestPiiExport");
}

const purgeSchema = z.object({
  collegeId: z.string().trim().min(1, "Enter a roll number.").max(64),
  before: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date (yyyy-mm-dd).")
    .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), "Pick a real date."),
  includeAccepted: z.boolean().default(false),
  reason: reasonSchema,
});
export type RequestSubmissionPurgeInput = z.input<typeof purgeSchema>;

/** One student's PRACTICE sources before a date. Verdict rows are kept; refused under legal hold. */
export async function requestSubmissionPurge(
  input: RequestSubmissionPurgeInput,
): Promise<ActionResult<{ id: string; expiresAt: string; count: number }>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const parsed = purgeSchema.parse(input);
    await enforcePrivilegedRequestRate(actor.id);
    if ((await readRetention()).legalHold) throw new ValidationError(LEGAL_HOLD_MESSAGE);
    const cutoff = purgeCutoff(parsed.before);
    if (cutoff.getTime() > Date.now()) throw new ValidationError("The date must not be in the future.");
    const user = await db.user.findFirst({
      where: { collegeId: { equals: parsed.collegeId, mode: "insensitive" } },
      select: { id: true, collegeId: true },
    });
    if (!user) throw new NotFoundError(`No account has the roll number ${parsed.collegeId}.`);
    const count = await db.submission.count({
      where: {
        userId: user.id,
        origin: "PRACTICE",
        createdAt: { lt: cutoff },
        status: { in: ["DONE", "INTERNAL_ERROR", "CANCELLED"] },
        source: { is: { archivedAt: null } },
        ...(parsed.includeAccepted ? {} : { OR: [{ verdict: null }, { verdict: { not: "AC" } }] }),
      },
    });
    if (count === 0) throw new ValidationError("No practice source matches. Nothing to purge.");
    const op = await createPrivilegedOperation({
      kind: "SUBMISSION_PURGE",
      payload: { userId: user.id, before: parsed.before, includeAccepted: parsed.includeAccepted },
      summary: `Purge ${count} practice source(s) of ${user.collegeId} before ${parsed.before}${
        parsed.includeAccepted ? " (accepted included)" : ""
      }`,
      affectedCount: count,
      reason: parsed.reason,
      actor,
    });
    await audit({
      actorId: actor.id,
      action: "submission.purge_requested",
      entityType: "User",
      entityId: user.id,
      targetUserId: user.id,
      sensitivity: "SENSITIVE",
      metadata: { operationId: op.id, before: parsed.before, includeAccepted: parsed.includeAccepted, count },
      ipHash: await requestIpHash(),
    });
    revalidatePath("/super/data");
    return { id: op.id, expiresAt: op.expiresAt.toISOString(), count };
  }, "requestSubmissionPurge");
}
