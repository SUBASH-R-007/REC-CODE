"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma } from "@recx/db";
import { GLOBAL_REJUDGE_MAX, LANGUAGE_KEYS, VERDICTS } from "@recx/shared";
import { audit } from "@/lib/audit";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { ConflictError, NotFoundError, ValidationError, runAction, type ActionResult } from "@/lib/errors";
import { requestIpHash } from "@/lib/ip";
import { generateNodeToken } from "@/lib/judge/node-token";
import { SOURCE_NOT_ARCHIVED_SQL } from "@/lib/judge/rejudge";
import { createPrivilegedOperation } from "@/lib/privileged/operations";
import { enforcePrivilegedRequestRate } from "@/lib/privileged/rate";

/**
 * Judge governance, SUPER_ADMIN only.
 *
 *   rotateJudgeNodeToken  judge.node.token_rotated (SECURITY)  capability "judge.rotateKeys"
 *   requestGlobalRejudge  privileged.requested (SENSITIVE)     capability "problems.lifecycle"
 *
 * A rotated token is returned ONCE to the caller (the page shows it in a
 * dialog) and is never stored, logged or audited: only its sha256 reaches
 * JudgeNode.tokenHash, and the old token stops working at once.
 */

const idSchema = z.string().trim().min(1).max(64);
const reasonSchema = z
  .string()
  .trim()
  .min(10, "Give a reason of at least 10 characters. It is recorded in the audit log.")
  .max(500, "Keep the reason under 500 characters.");

const rotateSchema = z.object({ nodeId: idSchema, reason: reasonSchema });
export type RotateJudgeNodeTokenInput = z.input<typeof rotateSchema>;

export async function rotateJudgeNodeToken(
  input: RotateJudgeNodeTokenInput,
): Promise<ActionResult<{ nodeId: string; token: string }>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const parsed = rotateSchema.parse(input);
    const node = await db.judgeNode.findUnique({ where: { id: parsed.nodeId }, select: { id: true, hostname: true } });
    if (!node) throw new NotFoundError("That judge node was not found.");
    const { token, tokenHash } = generateNodeToken();
    const moved = await db.judgeNode.updateMany({ where: { id: node.id }, data: { tokenHash } });
    if (moved.count !== 1) throw new ConflictError("That judge node was removed a moment ago.");
    await audit({
      actorId: actor.id,
      action: "judge.node.token_rotated",
      entityType: "JudgeNode",
      entityId: node.id,
      sensitivity: "SECURITY",
      // Never the token or its hash.
      metadata: { hostname: node.hostname, via: "ui", reason: parsed.reason },
      ipHash: await requestIpHash(),
    });
    return { nodeId: node.id, token };
  }, "rotateJudgeNodeToken");
}

const rejudgeSchema = z.object({
  problemId: idSchema,
  problemVersionId: z.preprocess((v) => (v === "" ? null : v), idSchema.nullable().optional()),
  languages: z.array(z.enum(LANGUAGE_KEYS)).max(LANGUAGE_KEYS.length).default([]),
  verdicts: z.array(z.enum(VERDICTS)).max(VERDICTS.length).default([]),
  reason: reasonSchema,
});
export type RequestGlobalRejudgeInput = z.input<typeof rejudgeSchema>;

/**
 * Request a rejudge of one problem's judged submissions (optionally one
 * pinned revision, some languages, some verdicts). The count shown to the
 * approver is taken now; the executor takes every matching row queued
 * before the approval, up to 25,000.
 */
export async function requestGlobalRejudge(
  input: RequestGlobalRejudgeInput,
): Promise<ActionResult<{ id: string; expiresAt: string; count: number }>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const parsed = rejudgeSchema.parse(input);
    await enforcePrivilegedRequestRate(actor.id);
    const problem = await db.problem.findUnique({
      where: { id: parsed.problemId },
      select: { id: true, displayCode: true, title: true },
    });
    if (!problem) throw new NotFoundError("That problem was not found.");
    const problemVersionId = parsed.problemVersionId ?? null;
    let revisionLabel = "";
    if (problemVersionId) {
      const version = await db.problemVersion.findFirst({
        where: { id: problemVersionId, problemId: problem.id },
        select: { revision: true },
      });
      if (!version) throw new NotFoundError("That revision does not belong to this problem.");
      revisionLabel = `, revision ${version.revision}`;
    }
    const filters: Prisma.Sql[] = [
      Prisma.sql`"problemId" = ${problem.id}`,
      Prisma.sql`status IN ('DONE', 'INTERNAL_ERROR')`,
      // The executor skips purged submissions too, so the approved count matches.
      SOURCE_NOT_ARCHIVED_SQL,
    ];
    if (problemVersionId) filters.push(Prisma.sql`"problemVersionId" = ${problemVersionId}`);
    if (parsed.languages.length > 0) filters.push(Prisma.sql`language = ANY(${parsed.languages}::text[])`);
    if (parsed.verdicts.length > 0) filters.push(Prisma.sql`verdict::text = ANY(${parsed.verdicts}::text[])`);
    const counted = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM (
        SELECT 1 FROM "Submission" WHERE ${Prisma.join(filters, " AND ")} LIMIT ${GLOBAL_REJUDGE_MAX + 1}
      ) capped`;
    const count = Number(counted[0]?.n ?? 0);
    if (count === 0) throw new ValidationError("No judged submission matches. Nothing to rejudge.");
    if (count > GLOBAL_REJUDGE_MAX) {
      throw new ValidationError(
        `More than ${GLOBAL_REJUDGE_MAX.toLocaleString("en-IN")} submissions match. Narrow it by revision, language or verdict.`,
      );
    }
    const scope = [
      parsed.languages.length > 0 ? `languages ${parsed.languages.join(", ")}` : null,
      parsed.verdicts.length > 0 ? `verdicts ${parsed.verdicts.join(", ")}` : null,
    ].filter(Boolean);
    const op = await createPrivilegedOperation({
      kind: "GLOBAL_REJUDGE",
      payload: { problemId: problem.id, problemVersionId, languages: parsed.languages, verdicts: parsed.verdicts },
      summary: `Rejudge ${count} submission(s) of ${problem.displayCode} ${problem.title}${revisionLabel}${
        scope.length > 0 ? ` (${scope.join("; ")})` : ""
      }`,
      affectedCount: count,
      reason: parsed.reason,
      actor,
    });
    revalidatePath("/super");
    return { id: op.id, expiresAt: op.expiresAt.toISOString(), count };
  }, "requestGlobalRejudge");
}
