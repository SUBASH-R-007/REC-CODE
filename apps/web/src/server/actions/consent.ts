"use server";

import { requireActionUser } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { runAction, NotFoundError, type ActionResult } from "@/lib/errors";
import { recordConsent } from "@/lib/exam/consent";
import { requestIpHash } from "@/lib/ip";

/**
 * Recording what a candidate agreed to (Phase 16e).
 *
 * SPEC §6 asks for a `ConsentRecord` per assessment. The readiness page has
 * asked for the agreement since Phase 6c — "I have read what is recorded and
 * I am ready to start" — and threw it away: it was client state, gone the
 * moment the page was. This is the half that was missing.
 *
 * Not audited. The row IS the record, it is append-only, and an audit entry
 * beside it would be a second copy of the same fact with a different
 * retention rule. What IS recorded is the hashed address, as everywhere
 * else in the exam surface, because a consent record that cannot be placed
 * is weaker evidence than one that can.
 *
 * Idempotent: pressing the control twice is one record. The unique index
 * says so and a second press is not a second decision.
 */
export async function recordProctoringConsent(input: { slug: string }): Promise<ActionResult<{ recorded: boolean }>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const slug = String(input?.slug ?? "").trim();
    const assessment = await db.assessment.findUnique({ where: { slug }, select: { id: true, status: true } });
    // The same sentence for "no such paper" and "not published": a candidate
    // who can see neither should learn nothing from the difference.
    if (!assessment || assessment.status === "DRAFT") throw new NotFoundError("That assessment does not exist.");
    return recordConsent({ userId: user.id, assessmentId: assessment.id, ipHash: await requestIpHash() });
  }, "recordProctoringConsent");
}
