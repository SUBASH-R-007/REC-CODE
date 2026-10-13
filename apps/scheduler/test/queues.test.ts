import { JUDGE_LANES, JUDGE_RETRY, LANE_PRIORITY } from "@recx/shared";
import { describe, expect, it } from "vitest";
import { ensureJob, judgeJobOptions } from "../src/queues";
import { FakeQueues } from "./support/fake-queues";

describe("judgeJobOptions", () => {
  it("matches the web app's enqueue options for every lane", () => {
    for (const lane of JUDGE_LANES) {
      expect(judgeJobOptions(lane, "sub_1")).toEqual({
        jobId: "sub_1",
        priority: LANE_PRIORITY[lane],
        attempts: JUDGE_RETRY.attempts,
        backoff: { type: "exponential", delay: JUDGE_RETRY.backoffMs },
        removeOnComplete: { age: 3600, count: 10_000 },
        removeOnFail: { age: 86_400 },
      });
    }
  });

  it("uses the row id as the BullMQ job id so enqueues dedupe", () => {
    expect(judgeJobOptions("RUN", "run_42").jobId).toBe("run_42");
  });
});

describe("ensureJob", () => {
  const data = { kind: "submission" as const, id: "sub_1" };

  it("adds a missing job", async () => {
    const q = new FakeQueues();
    expect(await ensureJob(q, "PRACTICE", data, false)).toBe("added");
    expect(q.added).toEqual([{ lane: "PRACTICE", data }]);
    expect(q.removed).toEqual([]);
  });

  it.each(["waiting", "prioritized", "delayed", "active"])("keeps a %s job", async (state) => {
    const q = new FakeQueues();
    q.setState("CONTEST", "sub_1", state);
    expect(await ensureJob(q, "CONTEST", data, false)).toBe("kept");
    expect(q.added).toEqual([]);
    expect(q.removed).toEqual([]);
  });

  it.each(["completed", "failed"])("removes a %s job and adds it again", async (state) => {
    const q = new FakeQueues();
    q.setState("PRACTICE", "sub_1", state);
    expect(await ensureJob(q, "PRACTICE", data, false)).toBe("replaced");
    expect(q.removed).toEqual([{ lane: "PRACTICE", id: "sub_1" }]);
    expect(q.added).toEqual([{ lane: "PRACTICE", data }]);
    expect(q.stateOf("PRACTICE", "sub_1")).toBe("waiting");
  });

  it("does not add over a stale job BullMQ refused to remove", async () => {
    const q = new FakeQueues();
    q.setState("PRACTICE", "sub_1", "completed");
    q.locked.add("sub_1");
    expect(await ensureJob(q, "PRACTICE", data, false)).toBe("remove-refused");
    expect(q.added).toEqual([]);
  });

  it("only reads in a dry run", async () => {
    const q = new FakeQueues();
    q.setState("PRACTICE", "sub_1", "failed");
    expect(await ensureJob(q, "PRACTICE", data, true)).toBe("replaced");
    expect(await ensureJob(q, "PRACTICE", { kind: "submission", id: "sub_2" }, true)).toBe("added");
    expect(q.added).toEqual([]);
    expect(q.removed).toEqual([]);
  });
});
