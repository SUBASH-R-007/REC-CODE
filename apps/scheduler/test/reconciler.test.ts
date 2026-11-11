import { describe, expect, it } from "vitest";
import { emptyReport, tickDidWork, type TickReport } from "../src/reconciler";

/** tickDidWork decides whether a tick earns an info-level log line (main.ts). */
describe("tickDidWork", () => {
  const report = (patch: (r: TickReport) => void) => {
    const r = emptyReport(false);
    patch(r);
    return r;
  };

  it("is quiet for an idle tick", () => {
    expect(tickDidWork(emptyReport(false))).toBe(false);
    expect(tickDidWork(emptyReport(true))).toBe(false);
  });

  it("starts with every retention table at zero and no hold", () => {
    expect(emptyReport(false).retention).toEqual({ hold: "none", purged: { SubmissionTestDetail: 0 } });
  });

  it("does not count a legal hold on its own (it is logged separately, once per tick)", () => {
    expect(tickDidWork(report((r) => (r.retention.hold = "legal-hold")))).toBe(false);
    expect(tickDidWork(report((r) => (r.retention.hold = "invalid-setting")))).toBe(false);
  });

  it.each<[string, (r: TickReport) => void]>([
    ["a node going offline", (r) => (r.nodesOffline = 1)],
    ["a lease expired by the node sweep", (r) => (r.leasesExpiredByNodeSweep = 1)],
    ["sensitive lanes withdrawn", (r) => (r.nodesLaneRestricted = 1)],
    ["a row marked dispatched", (r) => (r.markedDispatched = 1)],
    ["a requeue", (r) => (r.requeued = 1)],
    ["an exhausted row", (r) => (r.failed = 1)],
    ["a deleted run", (r) => (r.runsDeleted = 1)],
    ["a purged test detail", (r) => (r.retention.purged.SubmissionTestDetail = 1)],
    ["an added job", (r) => (r.jobs.added = 1)],
    ["a deferred enqueue", (r) => (r.jobs.deferred = 1)],
    ["a capped phase", (r) => r.capped.push("retention:SubmissionTestDetail")],
  ])("reports %s", (_name, patch) => {
    expect(tickDidWork(report(patch))).toBe(true);
  });

  it("does not count jobs that were already live", () => {
    expect(tickDidWork(report((r) => (r.jobs.kept = 5)))).toBe(false);
  });
});
