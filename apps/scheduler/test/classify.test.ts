import { JUDGE_LANES, JUDGE_OFFLINE_AFTER_MS, JUDGE_RETRY, LIMITS, SENSITIVE_LANES, jobKindSchema } from "@recx/shared";
import { describe, expect, it } from "vitest";
import {
  FIXED_LANE,
  QUEUED_GRACE_MS,
  RETENTION_DELETE_BATCH,
  RETENTION_SETTING_KEY,
  SELF_CHECK_STALE_RESTRICTION,
  classifyJobState,
  classifyLease,
  classifyNode,
  classifyNodeLanes,
  classifyQueued,
  classifyRetention,
  classifyRetentionAge,
  jobLane,
  partition,
} from "../src/classify";

const NOW = new Date("2026-10-10T10:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const ahead = (ms: number) => new Date(NOW.getTime() + ms);
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

describe("jobLane", () => {
  it("puts every submission on its own lane", () => {
    for (const lane of JUDGE_LANES) expect(jobLane("submission", lane)).toBe(lane);
  });

  it("always puts runs on RUN and validation runs on REJUDGE", () => {
    expect(jobLane("run", null)).toBe("RUN");
    expect(jobLane("validation", null)).toBe("REJUDGE");
    // A fixed lane wins over anything a row might carry.
    expect(jobLane("run", "ASSESSMENT")).toBe("RUN");
    expect(jobLane("validation", "CONTEST")).toBe("REJUDGE");
  });

  it("covers every job kind", () => {
    expect(Object.keys(FIXED_LANE).sort()).toEqual([...jobKindSchema.options].sort());
  });

  it("never puts authoring work on a sensitive lane", () => {
    expect(SENSITIVE_LANES).not.toContain(FIXED_LANE.validation);
  });

  it("refuses a submission without a lane rather than guess one", () => {
    expect(() => jobLane("submission", null)).toThrow(/lane/);
  });
});

describe("classifyQueued", () => {
  const row = (ageMs: number, attemptCount = 0) => ({ id: "s1", attemptCount, since: ago(ageMs) });

  it("uses a 5 second grace window", () => {
    expect(QUEUED_GRACE_MS).toBe(5_000);
  });

  it("leaves a young QUEUED row to the web app's own enqueue", () => {
    expect(classifyQueued(row(0), NOW)).toBe("wait");
    expect(classifyQueued(row(1_000), NOW)).toBe("wait");
    // "Older than 5 s" is strict: exactly 5 s is still young.
    expect(classifyQueued(row(QUEUED_GRACE_MS), NOW)).toBe("wait");
  });

  it("dispatches a QUEUED row older than the grace window", () => {
    expect(classifyQueued(row(QUEUED_GRACE_MS + 1), NOW)).toBe("dispatch");
    expect(classifyQueued(row(60 * 60_000, JUDGE_RETRY.attempts - 1), NOW)).toBe("dispatch");
  });

  it("fails an old QUEUED row whose attempts are spent instead of re-enqueueing it forever", () => {
    expect(classifyQueued(row(60_000, JUDGE_RETRY.attempts), NOW)).toBe("fail");
    expect(classifyQueued(row(60_000, JUDGE_RETRY.attempts + 2), NOW)).toBe("fail");
  });

  it("gives even an exhausted row the grace window first", () => {
    expect(classifyQueued(row(1_000, JUDGE_RETRY.attempts), NOW)).toBe("wait");
  });
});

describe("classifyLease", () => {
  const row = (leaseExpiresAt: Date | null, attemptCount: number) => ({ id: "s1", attemptCount, leaseExpiresAt });

  it("keeps a live lease", () => {
    expect(classifyLease(row(ahead(60_000), 1), NOW)).toBe("keep");
    // Expiry is strict (`leaseExpiresAt < now`), matching the claim route.
    expect(classifyLease(row(NOW, 1), NOW)).toBe("keep");
  });

  it("requeues an expired lease below the attempt cap", () => {
    for (let attempts = 0; attempts < JUDGE_RETRY.attempts; attempts++) {
      expect(classifyLease(row(ago(1), attempts), NOW)).toBe("requeue");
    }
  });

  it("fails an expired lease at or above the attempt cap", () => {
    expect(JUDGE_RETRY.attempts).toBe(3);
    expect(classifyLease(row(ago(1), JUDGE_RETRY.attempts), NOW)).toBe("fail");
    expect(classifyLease(row(ago(1), JUDGE_RETRY.attempts + 1), NOW)).toBe("fail");
  });

  it("treats a JUDGING row with no lease as expired, like the claim route does", () => {
    expect(classifyLease(row(null, 0), NOW)).toBe("requeue");
    expect(classifyLease(row(null, JUDGE_RETRY.attempts), NOW)).toBe("fail");
  });

  it("honours an explicit attempt cap", () => {
    expect(classifyLease(row(ago(1), 1), NOW, 1)).toBe("fail");
  });
});

describe("classifyNode", () => {
  const node = (status: "ONLINE" | "DRAINING" | "OFFLINE" | "QUARANTINED", lastHeartbeatAt: Date | null) => ({
    id: "n1",
    status,
    lastHeartbeatAt,
  });

  it("uses the shared 20 second threshold", () => {
    expect(JUDGE_OFFLINE_AFTER_MS).toBe(20_000);
  });

  it("keeps a node that heartbeated within the threshold", () => {
    expect(classifyNode(node("ONLINE", ago(1_000)), NOW)).toBe("keep");
    expect(classifyNode(node("ONLINE", ago(JUDGE_OFFLINE_AFTER_MS - 1)), NOW)).toBe("keep");
    // "Older than 20 s" is strict.
    expect(classifyNode(node("ONLINE", ago(JUDGE_OFFLINE_AFTER_MS)), NOW)).toBe("keep");
  });

  it("marks ONLINE and DRAINING nodes OFFLINE past the threshold", () => {
    expect(classifyNode(node("ONLINE", ago(JUDGE_OFFLINE_AFTER_MS + 1)), NOW)).toBe("offline");
    expect(classifyNode(node("DRAINING", ago(5 * 60_000)), NOW)).toBe("offline");
  });

  it("marks a live-status node that never heartbeated OFFLINE", () => {
    expect(classifyNode(node("ONLINE", null), NOW)).toBe("offline");
  });

  it("never touches OFFLINE or QUARANTINED nodes", () => {
    expect(classifyNode(node("OFFLINE", ago(60 * 60_000)), NOW)).toBe("keep");
    expect(classifyNode(node("QUARANTINED", ago(60 * 60_000)), NOW)).toBe("keep");
    expect(classifyNode(node("QUARANTINED", null), NOW)).toBe("keep");
  });

  it("tolerates a heartbeat slightly ahead of the database clock", () => {
    expect(classifyNode(node("ONLINE", ahead(500)), NOW)).toBe("keep");
  });
});

describe("classifyNodeLanes", () => {
  type Status = "ONLINE" | "DRAINING" | "OFFLINE" | "QUARANTINED";
  const node = (status: Status, sensitiveLanesOk: boolean, lastSelfCheckAt: Date | null) => ({
    status,
    sensitiveLanesOk,
    lastSelfCheckAt,
  });
  const STALE = LIMITS.selfCheck.staleAfterMs;

  it("uses the shared 6.5 hour staleness threshold and restriction label", () => {
    expect(STALE).toBe(6.5 * HOUR);
    expect(SELF_CHECK_STALE_RESTRICTION).toBe("self-check stale");
  });

  it("keeps an ONLINE node with a fresh self-check", () => {
    expect(classifyNodeLanes(node("ONLINE", true, ago(HOUR)), NOW)).toBe("keep");
    expect(classifyNodeLanes(node("ONLINE", true, ago(STALE - 1)), NOW)).toBe("keep");
    // "Older than 6.5 h" is strict.
    expect(classifyNodeLanes(node("ONLINE", true, ago(STALE)), NOW)).toBe("keep");
    // A self-check timestamp slightly ahead of the database clock is fresh.
    expect(classifyNodeLanes(node("ONLINE", true, ahead(500)), NOW)).toBe("keep");
  });

  it("restricts an ONLINE node whose self-check went stale", () => {
    expect(classifyNodeLanes(node("ONLINE", true, ago(STALE + 1)), NOW)).toBe("restrict");
    expect(classifyNodeLanes(node("ONLINE", true, ago(7 * HOUR)), NOW)).toBe("restrict");
  });

  it("restricts an ONLINE node that never reported a self-check", () => {
    expect(classifyNodeLanes(node("ONLINE", true, null), NOW)).toBe("restrict");
  });

  it("leaves a node whose sensitive lanes are already withheld", () => {
    expect(classifyNodeLanes(node("ONLINE", false, ago(7 * HOUR)), NOW)).toBe("keep");
    expect(classifyNodeLanes(node("ONLINE", false, null), NOW)).toBe("keep");
  });

  it("only acts on ONLINE nodes", () => {
    for (const status of ["DRAINING", "OFFLINE", "QUARANTINED"] as const) {
      expect(classifyNodeLanes(node(status, true, ago(7 * HOUR)), NOW)).toBe("keep");
      expect(classifyNodeLanes(node(status, true, null), NOW)).toBe("keep");
    }
  });

  it("honours an explicit threshold", () => {
    expect(classifyNodeLanes(node("ONLINE", true, ago(2_000)), NOW, 1_000)).toBe("restrict");
  });
});

describe("classifyRetention", () => {
  it("reads the 'retention' platform setting", () => {
    expect(RETENTION_SETTING_KEY).toBe("retention");
  });

  it("purges when there is no setting", () => {
    expect(classifyRetention(undefined)).toEqual({ action: "purge" });
  });

  it("holds every purge under a legal hold", () => {
    expect(classifyRetention({ legalHold: true })).toEqual({ action: "hold", reason: "legal-hold" });
    // Other keys may live alongside it.
    expect(classifyRetention({ legalHold: true, note: "case 2026-14" })).toEqual({ action: "hold", reason: "legal-hold" });
  });

  it("purges when the hold is off or absent", () => {
    expect(classifyRetention({ legalHold: false })).toEqual({ action: "purge" });
    expect(classifyRetention({})).toEqual({ action: "purge" });
    expect(classifyRetention({ detailDays: 30 })).toEqual({ action: "purge" });
  });

  it("holds (fails closed) on a malformed setting, since deletion cannot be undone", () => {
    for (const value of [{ legalHold: "true" }, { legalHold: 1 }, null, "hold", 42, [true]]) {
      const decision = classifyRetention(value);
      expect(decision.action).toBe("hold");
      if (decision.action === "hold") expect(decision.reason).toBe("invalid-setting");
    }
    const decision = classifyRetention({ legalHold: "yes" });
    expect(decision).toMatchObject({ action: "hold", reason: "invalid-setting" });
    if (decision.action === "hold" && decision.reason === "invalid-setting") expect(decision.issue).toMatch(/legalHold/);
  });
});

describe("classifyRetentionAge", () => {
  const DETAIL_DAYS = LIMITS.detail.retentionDays;

  it("keeps SubmissionTestDetail for 30 days, purged in batches of 10,000", () => {
    expect(DETAIL_DAYS).toBe(30);
    expect(RETENTION_DELETE_BATCH).toBe(10_000);
  });

  it("keeps a row inside the window", () => {
    expect(classifyRetentionAge(ago(0), NOW)).toBe("keep");
    expect(classifyRetentionAge(ago(29 * DAY), NOW)).toBe("keep");
    // "Older than 30 days" is strict, like the purge SQL.
    expect(classifyRetentionAge(ago(DETAIL_DAYS * DAY), NOW)).toBe("keep");
    expect(classifyRetentionAge(ahead(1_000), NOW)).toBe("keep");
  });

  it("purges a row past the window", () => {
    expect(classifyRetentionAge(ago(DETAIL_DAYS * DAY + 1), NOW)).toBe("purge");
    expect(classifyRetentionAge(ago(365 * DAY), NOW)).toBe("purge");
  });

  it("honours an explicit window", () => {
    expect(classifyRetentionAge(ago(2 * DAY), NOW, 1)).toBe("purge");
    expect(classifyRetentionAge(ago(2 * DAY), NOW, 3)).toBe("keep");
  });
});

describe("classifyJobState", () => {
  it("keeps every live BullMQ state", () => {
    for (const state of ["waiting", "prioritized", "delayed", "active", "waiting-children"]) {
      expect(classifyJobState(state)).toBe("keep");
    }
  });

  it("replaces a terminal job (BullMQ dedupes on jobId)", () => {
    expect(classifyJobState("completed")).toBe("replace");
    expect(classifyJobState("failed")).toBe("replace");
  });

  it("adds a missing job", () => {
    expect(classifyJobState("unknown")).toBe("add");
  });
});

describe("partition", () => {
  it("groups rows by action and preserves order", () => {
    const groups = partition([1, 2, 3, 4, 5], (n) => (n % 2 === 0 ? "even" : "odd"));
    expect(groups.get("odd")).toEqual([1, 3, 5]);
    expect(groups.get("even")).toEqual([2, 4]);
  });

  it("returns an empty map for no rows", () => {
    expect(partition([], () => "x").size).toBe(0);
  });
});
