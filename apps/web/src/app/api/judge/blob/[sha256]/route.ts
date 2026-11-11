import { z } from "zod";
import { Prisma } from "@recx/db";
import { jobKindSchema, type JobKind } from "@recx/shared";
import { db } from "@/lib/db";
import { JOB_TABLE } from "@/lib/judge/claim";
import { authenticateNode, judgeJson, judgeRoute } from "@/lib/judge/node-auth";
import { KeyNotFoundError } from "@/lib/testdata/keys";
import { getTestDataStore } from "@/lib/testdata/store";

export const runtime = "nodejs";

const paramsSchema = z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/) });
const querySchema = z.object({
  kind: jobKindSchema,
  id: z.string().min(1).max(64),
  claimToken: z.string().min(16).max(128),
});

/** Which of its version's test blobs a held job may read. */
type TestScope = "all" | "samples" | "none";

const heldJobRowSchema = z.object({
  problemVersionId: z.string(),
  custom: z.boolean(),
  compareMode: z.string(),
  checkerSha256: z.string().nullable(),
  interactorSha256: z.string().nullable(),
});

/**
 * Is this blob part of the job this node currently holds? Only while the
 * lease is live, only for the node that claimed it, and only from the job's
 * PINNED version:
 *  - a test input or expected output — every test for a submission or a
 *    validation run, sample tests only for a run, nothing for a custom-stdin
 *    run (its input came inline);
 *  - the version's checker source, when the version is CHECKER-compared;
 *  - the version's interactor source, when it is INTERACTIVE (Phase 12l) —
 *    the one program that decides that problem's verdict, and as much the
 *    job's own data as the checker is.
 * Reference solutions and anything else are never reachable.
 */
async function blobBelongsToJob(
  kind: JobKind,
  id: string,
  claimToken: string,
  nodeId: string,
  sha256: string,
): Promise<boolean> {
  const custom = kind === "run" ? Prisma.sql`(j."customInput" IS NOT NULL)` : Prisma.sql`false`;
  const rows = await db.$queryRaw<unknown[]>`
    SELECT j."problemVersionId", ${custom} AS custom, v."compareMode"::text AS "compareMode",
           v."checkerSha256", v."interactorSha256"
    FROM ${JOB_TABLE[kind]} j JOIN "ProblemVersion" v ON v.id = j."problemVersionId"
    WHERE j.id = ${id} AND j."claimToken" = ${claimToken} AND j."claimedByNodeId" = ${nodeId}
      AND j."leaseExpiresAt" > now()`;
  const parsed = heldJobRowSchema.safeParse(rows[0]);
  if (!parsed.success) return false;
  const job = parsed.data;

  if (job.compareMode === "CHECKER" && job.checkerSha256 === sha256) return true;
  if (job.compareMode === "INTERACTIVE" && job.interactorSha256 === sha256) return true;

  const scope: TestScope = kind === "run" ? (job.custom ? "none" : "samples") : "all";
  if (scope === "none") return false;
  const testCase = await db.testCase.findFirst({
    where: {
      problemVersionId: job.problemVersionId,
      ...(scope === "samples" ? { isSample: true } : {}),
      OR: [{ inputSha256: sha256 }, { outputSha256: sha256 }],
    },
    select: { id: true },
  });
  return testCase !== null;
}

/** One blob for the claimed job, verified by the worker against x-content-sha256. */
export async function GET(request: Request, { params }: { params: Promise<{ sha256: string }> }) {
  return judgeRoute("blob", async () => {
    const auth = await authenticateNode(request);
    if (!auth.ok) return auth.response;

    const param = paramsSchema.safeParse(await params);
    const url = new URL(request.url);
    const query = querySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!param.success || !query.success) return judgeJson({ error: "Invalid blob request." }, 400);
    const { sha256 } = param.data;
    const { kind, id, claimToken } = query.data;

    if (!(await blobBelongsToJob(kind, id, claimToken, auth.node.id, sha256))) {
      return judgeJson({ error: "This blob is not part of a job this node currently holds." }, 403);
    }

    const blob = await db.testBlob.findUnique({
      where: { sha256 },
      select: { sizeBytes: true, inline: true, storageKey: true },
    });
    if (!blob) return judgeJson({ error: "Blob not found." }, 404);

    const headers = {
      "content-type": "application/octet-stream",
      "content-length": String(blob.sizeBytes),
      "x-content-sha256": sha256,
      "cache-control": "no-store",
    };
    if (blob.inline !== null) {
      return new Response(new Uint8Array(Buffer.from(blob.inline, "utf8")), { headers });
    }
    if (!blob.storageKey) return judgeJson({ error: "Blob has no content." }, 500);
    try {
      return new Response(await getTestDataStore().stream(blob.storageKey), { headers });
    } catch (error) {
      if (error instanceof KeyNotFoundError) {
        console.error(`[judge] !!! TestBlob ${sha256} points at missing storage key ${blob.storageKey}`);
        return judgeJson({ error: "Blob content is missing from storage." }, 500);
      }
      throw error;
    }
  });
}
