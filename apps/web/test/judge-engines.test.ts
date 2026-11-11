import { describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JUDGE_LANES, queueNameFor } from "@recx/shared";

/**
 * The fleet, by engine (Phase 12k, slice 5).
 *
 * A lane has one queue per engine now. The lane figure must be the SUM —
 * it is what the page's totals and the alert rules read — and the split
 * must be there beside it, because "which engine" is the first question
 * asked about a backed-up lane once there are two of them.
 */

const h = vi.hoisted(() => ({ counts: new Map<string, Record<string, number>>(), queues: [] as string[] }));

vi.mock("bullmq", () => ({
  Queue: class {
    readonly name: string;
    constructor(name: string) {
      this.name = name;
      h.queues.push(name);
    }
    on() {
      return this;
    }
    async getJobCounts() {
      return h.counts.get(this.name) ?? {};
    }
  },
}));
vi.mock("@/lib/redis", () => ({ redis: () => ({}) }));
vi.mock("@/lib/db", () => ({ db: {} }));

const { loadQueueDepths } = await import("@/server/queries/admin-judge");
const { EngineTable } = await import("@/components/admin/engine-table");
type AdminNodeRow = import("@/server/queries/admin-judge").AdminNodeRow;

(globalThis as { React?: typeof React }).React = React;

const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("loadQueueDepths", () => {
  it("reads both engines of every lane", async () => {
    h.queues.length = 0;
    await loadQueueDepths();
    for (const lane of JUDGE_LANES) {
      expect(h.queues, lane).toContain(queueNameFor("isolate", lane));
      expect(h.queues, lane).toContain(queueNameFor("postgres", lane));
    }
  });

  it("sums a lane and splits it by engine", async () => {
    h.counts.set(queueNameFor("isolate", "PRACTICE"), { waiting: 5, prioritized: 2, active: 1, delayed: 0 });
    h.counts.set(queueNameFor("postgres", "PRACTICE"), { waiting: 3, active: 2, delayed: 4 });

    const depths = await loadQueueDepths();
    expect(depths?.byLane.PRACTICE).toEqual({ waiting: 10, active: 3, delayed: 4 });
    expect(depths?.byEngine.isolate.waiting).toBe(7);
    expect(depths?.byEngine.postgres.waiting).toBe(3);
    expect(depths?.byEngine.postgres.delayed).toBe(4);
  });
});

describe("the Engines table", () => {
  const node = (over: Partial<AdminNodeRow> = {}): AdminNodeRow =>
    ({
      id: "judge-1",
      hostname: "judge-1",
      status: "ONLINE",
      driver: "isolate",
      engine: "isolate",
      workerVersion: "1.0.0",
      isolateVersion: "2.7",
      engineVersion: "",
      slots: 5,
      busySlots: 2,
      heartbeatAgeMs: 1_000,
      heartbeatStale: false,
      calibrationScore: 1000,
      calibrationAgeMs: 1_000,
      calibrationDeviation: 0,
      calibrationOutlier: false,
      selfCheckState: "ok",
      selfCheckAgeMs: 1_000,
      selfCheckFailures: [],
      hardeningState: "ok",
      hardeningFailures: [],
      sensitiveLanesOk: true,
      laneRestrictions: [],
      languages: ["cpp20"],
      consecutiveIe: 0,
      selfCheckOk: true,
      hostHardened: true,
      ...over,
    }) as AdminNodeRow;

  const render = (nodes: AdminNodeRow[], depths: Parameters<typeof EngineTable>[0]["depths"]) =>
    renderToStaticMarkup(React.createElement(EngineTable, { nodes, depths }));

  it("counts nodes and slots for each engine separately", () => {
    const html = render(
      [node(), node({ id: "sql-judge-1", driver: "postgres", engine: "postgres", slots: 4, busySlots: 1 })],
      { isolate: { waiting: 2, active: 1, delayed: 0 }, postgres: { waiting: 0, active: 0, delayed: 0 } },
    );
    const body = text(html);
    expect(body).toContain("isolate (programs)");
    expect(body).toContain("PostgreSQL 17 (SQL)");
    expect(body).toContain("2 / 5");
    expect(body).toContain("1 / 4");
  });

  it("calls out work that no node of that engine can take", () => {
    const html = render([node()], {
      isolate: { waiting: 0, active: 0, delayed: 0 },
      postgres: { waiting: 12, active: 0, delayed: 3 },
    });
    // The state that needs a person: a queue with work in it and no node.
    expect(text(html)).toContain("Work is waiting and no node of this engine is online.");
    expect(html).toContain("bg-danger-subtle");
  });

  it("says nothing of the sort when the engine's nodes are simply busy", () => {
    const html = render([node({ id: "sql-judge-1", driver: "postgres", engine: "postgres" })], {
      isolate: { waiting: 0, active: 0, delayed: 0 },
      postgres: { waiting: 12, active: 4, delayed: 0 },
    });
    expect(text(html)).not.toContain("no node of this engine is online");
  });

  it("shows a dash rather than a zero when Redis cannot be read", () => {
    // A queue nobody can see is not an empty queue, and a page that says 0
    // during a Redis outage is a page that says the backlog is fine.
    const body = text(render([node()], null));
    // Waiting and active, for both engines: four unknowns, no zeros.
    expect((body.match(/—/g) ?? []).length).toBe(4);
  });
});
