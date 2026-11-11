"use server";

import { revalidatePath } from "next/cache";
import { audit } from "@/lib/audit";
import { requireActionRole, requireActionUser } from "@/lib/auth/guards";
import { runAction, type ActionResult } from "@/lib/errors";
import { requestIpHash } from "@/lib/ip";
import {
  clearQualityHoldAs,
  decideProblemReportAs,
  reportProblemFor,
  type DecidedReport,
  type ReportedProblem,
} from "@/lib/problems/reports";
import type { ClearQualityHoldInput, DecideProblemReportInput, ReportProblemInput } from "@/lib/problems/reports";

/**
 * A student says this problem is wrong, and a staff member answers
 * (Phase 16a, docs/ROADMAP.md §3.2).
 *
 * Reporting is open to anybody signed in, for the reason the discussion
 * report gives: a gate on the safety valve is not a safety valve. It is not
 * gated on having solved the problem either — the student most likely to
 * notice that case 3 is wrong is the one whose correct program it is
 * failing.
 *
 * Filing is not audited. It is the student's own study activity, like a hint
 * reveal, and the row with its timestamp IS the record. Every DECISION is
 * audited, because a decision is one person's answer about somebody else's
 * claim, and withholding a problem from new papers is a decision an
 * examiner will want explained later.
 */

const WORKSPACE = "/problems/[slug]";

export async function reportProblem(input: ReportProblemInput): Promise<ActionResult<ReportedProblem>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const report = await reportProblemFor(user.id, input);
    revalidatePath(WORKSPACE, "page");
    return report;
  }, "reportProblem");
}

export async function decideProblemReport(input: DecideProblemReportInput): Promise<ActionResult<DecidedReport>> {
  return runAction(async () => {
    const actor = await requireActionRole("ADMIN", "SUPER_ADMIN");
    const decided = await decideProblemReportAs(actor.id, input);
    await audit({
      actorId: actor.id,
      action: decided.held ? "problem.report_upheld_and_held" : `problem.report_${decided.status.toLowerCase()}`,
      entityType: "ProblemReport",
      entityId: decided.reportId,
      sensitivity: "NORMAL",
      // The reporter's id, never their sentence: the row holds the sentence.
      metadata: { problemId: decided.problemId, reporterId: decided.reporterId, held: decided.held },
      ipHash: await requestIpHash(),
    });
    revalidatePath(`/admin/problems/${decided.problemId}`);
    revalidatePath(WORKSPACE, "page");
    return decided;
  }, "decideProblemReport");
}

export async function clearQualityHold(input: ClearQualityHoldInput): Promise<ActionResult<{ problemId: string }>> {
  return runAction(async () => {
    const actor = await requireActionRole("ADMIN", "SUPER_ADMIN");
    const cleared = await clearQualityHoldAs(actor.id, input);
    await audit({
      actorId: actor.id,
      action: "problem.quality_hold_cleared",
      entityType: "Problem",
      entityId: cleared.problemId,
      sensitivity: "NORMAL",
      metadata: { previousReason: cleared.previousReason },
      ipHash: await requestIpHash(),
    });
    revalidatePath(`/admin/problems/${cleared.problemId}`);
    return { problemId: cleared.problemId };
  }, "clearQualityHold");
}
