import { claimRefusalSchema, claimRequestSchema } from "@recx/shared";
import { claimJob } from "@/lib/judge/claim";
import { authenticateNode, judgeJson, judgeRoute, readJudgeBody } from "@/lib/judge/node-auth";

export const runtime = "nodejs";

/**
 * Claim a job the worker received from BullMQ. 200 with a JudgeJobSpec on
 * success; 200 with a ClaimRefusal when the job is not (or no longer) this
 * node's to judge — the worker treats every refusal as "job done".
 */
export async function POST(request: Request) {
  return judgeRoute("claim", async () => {
    const auth = await authenticateNode(request);
    if (!auth.ok) return auth.response;
    const read = await readJudgeBody(request, claimRequestSchema);
    if (!read.ok) return read.response;

    const outcome = await claimJob(auth.node, read.body);
    // The spec was validated against judgeJobSpecSchema when it was built.
    return judgeJson(outcome.claimed ? outcome.spec : claimRefusalSchema.parse(outcome.refusal));
  });
}
