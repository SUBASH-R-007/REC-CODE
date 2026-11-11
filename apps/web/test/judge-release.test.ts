import { beforeEach, describe, expect, it, vi } from "vitest";
import { JUDGE_PROTOCOL_VERSION, type ReleaseRequest, type ResultRequest } from "@recx/shared";
import type { JudgeNode } from "@recx/db";

/**
 * releaseJob and discardQuarantinedResult with the lease SQL replaced:
 * a permanent release finalises INTERNAL_ERROR at once (audited as a
 * permanent failure, no requeue, no auto-drain count); an ordinary release
 * requeues and counts toward the auto-drain; a quarantined node's result is
 * requeued with its attempt refunded and audited, never stored. The same
 * paths run against a real database in judge-pipeline.db.test.ts.
 */
const mocks = vi.hoisted(() => ({
  markInternalError: vi.fn(async () => true),
  requeueLease: vi.fn(async (): Promise<{ attemptCount: number } | null> => ({ attemptCount: 1 })),
  publishProgress: vi.fn(async () => undefined),
  audit: vi.fn(async () => undefined),
  nodeUpdate: vi.fn(async () => ({ consecutiveIe: 1 })),
  nodeUpdateMany: vi.fn(async () => ({ count: 0 })),
}));

vi.mock("@/lib/judge/claim", () => ({
  markInternalError: mocks.markInternalError,
  requeueLease: mocks.requeueLease,
  publishProgress: mocks.publishProgress,
  JOB_ENTITY: { submission: "Submission", run: "RunRequest", validation: "ValidationRun" },
}));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/db", () => ({ db: { judgeNode: { update: mocks.nodeUpdate, updateMany: mocks.nodeUpdateMany } } }));
vi.mock("@/lib/judge/validation", () => ({ advanceValidation: vi.fn(), validationOutcome: vi.fn() }));

const { discardQuarantinedResult, releaseJob } = await import("@/lib/judge/finalize");

const node = { id: "judge-1", hostname: "judge-1", status: "ONLINE" } as JudgeNode;
const TOKEN = "t".repeat(43);

function release(overrides: Partial<ReleaseRequest> = {}): ReleaseRequest {
  return {
    protocolVersion: JUDGE_PROTOCOL_VERSION,
    kind: "submission",
    id: "cmsub000000000000000000001",
    claimToken: TOKEN,
    reason: "compare mode INTERACTIVE is not supported",
    permanent: false,
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("permanent release", () => {
  it.each(["submission", "run", "validation"] as const)("finalises a %s INTERNAL_ERROR at once", async (kind) => {
    expect(await releaseJob(node, release({ kind, permanent: true }))).toBe("ok");
    expect(mocks.markInternalError).toHaveBeenCalledWith(
      kind,
      "cmsub000000000000000000001",
      { claimToken: TOKEN, nodeId: "judge-1" },
      expect.objectContaining({ auditAction: `judge.${kind}.permanent_failure`, reason: expect.stringMatching(/INTERACTIVE/) as string }),
    );
    expect(mocks.requeueLease).not.toHaveBeenCalled();
    expect(mocks.nodeUpdate).not.toHaveBeenCalled();
  });

  it("is stale when the node no longer holds the job", async () => {
    mocks.markInternalError.mockResolvedValueOnce(false);
    expect(await releaseJob(node, release({ permanent: true }))).toBe("stale");
  });
});

describe("ordinary release", () => {
  it("requeues and counts toward the node's auto-drain", async () => {
    expect(await releaseJob(node, release({ reason: "isolate status XX" }))).toBe("ok");
    expect(mocks.requeueLease).toHaveBeenCalledWith("submission", "cmsub000000000000000000001", "judge-1", TOKEN);
    expect(mocks.markInternalError).not.toHaveBeenCalled();
    expect(mocks.nodeUpdate).toHaveBeenCalledTimes(1);
  });

  it("finalises INTERNAL_ERROR on the final attempt", async () => {
    mocks.requeueLease.mockResolvedValueOnce({ attemptCount: 3 });
    await releaseJob(node, release());
    expect(mocks.markInternalError).toHaveBeenCalledWith(
      "submission",
      "cmsub000000000000000000001",
      { exhausted: true },
      expect.objectContaining({ nodeId: "judge-1" }),
    );
  });
});

describe("a quarantined node's result", () => {
  const body = {
    protocolVersion: JUDGE_PROTOCOL_VERSION,
    kind: "submission",
    id: "cmsub000000000000000000001",
    claimToken: TOKEN,
    verdict: "AC",
  } as ResultRequest;

  it("is requeued with its attempt refunded, audited as a security event, and announced", async () => {
    await discardQuarantinedResult(node, body);
    expect(mocks.requeueLease).toHaveBeenCalledWith("submission", body.id, "judge-1", TOKEN, { refundAttempt: true });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "judge.result.discarded_quarantined",
        entityType: "Submission",
        entityId: body.id,
        sensitivity: "SECURITY",
      }),
    );
    expect(mocks.publishProgress).toHaveBeenCalledWith("submission", body.id, { type: "state", state: "QUEUED" });
  });

  it("changes nothing (and audits nothing) when the job was already taken back", async () => {
    mocks.requeueLease.mockResolvedValueOnce(null);
    await discardQuarantinedResult(node, body);
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.publishProgress).not.toHaveBeenCalled();
  });
});
