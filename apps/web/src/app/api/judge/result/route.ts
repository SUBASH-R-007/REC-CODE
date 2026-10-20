import { resultRequestSchema } from "@recx/shared";
import {
  discardQuarantinedResult,
  finalizeRun,
  finalizeSubmission,
  finalizeValidation,
} from "@/lib/judge/finalize";
import { authenticateNode, judgeJson, judgeRoute, readJudgeBody } from "@/lib/judge/node-auth";

export const runtime = "nodejs";

/**
 * A worker's final result for the job it holds. 200 {ok:true} when stored;
 * 409 {stale:true} when the claimToken no longer matches (a late result
 * from a node whose lease was taken over, or a retried callback), and when
 * the node is QUARANTINED — its result is discarded and the job requeued
 * for a healthy node.
 */
export async function POST(request: Request) {
  return judgeRoute("result", async () => {
    const auth = await authenticateNode(request);
    if (!auth.ok) return auth.response;
    const read = await readJudgeBody(request, resultRequestSchema);
    if (!read.ok) return read.response;
    const body = read.body;

    if (body.verdict === "IE") {
      // An internal error is not a statement about the student's code; the
      // worker must release the job so it is retried (or failed) centrally.
      return judgeJson({ error: "IE is not a reportable verdict. Release the job instead." }, 422);
    }
    if (body.judgeNodeId !== auth.node.id) {
      console.warn(`[judge] node ${auth.node.id} reported judgeNodeId ${body.judgeNodeId}; storing the authenticated id`);
    }
    if (auth.node.status === "QUARANTINED") {
      await discardQuarantinedResult(auth.node, body);
      return judgeJson({ stale: true }, 409);
    }

    const finalize =
      body.kind === "submission" ? finalizeSubmission : body.kind === "run" ? finalizeRun : finalizeValidation;
    const outcome = await finalize(auth.node, body);
    if (outcome === "stale") return judgeJson({ stale: true }, 409);
    // `judge_verdict_total` is counted inside the finalise functions, which
    // are the only place that holds the submission's LANGUAGE — the result
    // body does not carry it, and the judge protocol is not worth versioning
    // for a metric label.
    return judgeJson({ ok: true });
  });
}
