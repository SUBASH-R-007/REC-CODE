import { releaseRequestSchema } from "@recx/shared";
import { releaseJob } from "@/lib/judge/finalize";
import { authenticateNode, judgeJson, judgeRoute, readJudgeBody } from "@/lib/judge/node-auth";

export const runtime = "nodejs";

/**
 * Hand back a claimed job after an infrastructure failure. 200 {ok:true}
 * when released (the job is QUEUED again, or INTERNAL_ERROR after its final
 * attempt — or at once when the release is `permanent`); 409 {stale:true}
 * when this node no longer holds it.
 */
export async function POST(request: Request) {
  return judgeRoute("release", async () => {
    const auth = await authenticateNode(request);
    if (!auth.ok) return auth.response;
    const read = await readJudgeBody(request, releaseRequestSchema);
    if (!read.ok) return read.response;

    const outcome = await releaseJob(auth.node, read.body);
    if (outcome === "stale") return judgeJson({ stale: true }, 409);
    return judgeJson({ ok: true });
  });
}
