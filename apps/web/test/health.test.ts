import { describe, expect, it, vi } from "vitest";
import type { HealthReport } from "@recx/shared";

/**
 * `GET /api/health` answers 200 even when it is not ok (Phase 10a).
 *
 * The gate item this covers, from the phase design: *"/api/health answers
 * while the database is down, with ok: false and a 200"*. A health endpoint
 * that returns 500 tells a load balancer to stop asking and tells a deploy
 * script nothing it can act on — the status code says "I answered", and the
 * body says what is wrong.
 *
 * Both dependencies are stubbed rather than stopped: the point is the shape
 * of the answer when they are unreachable, and the live behaviour was read
 * off the running app (docs/RUNBOOK.md §3, 10a) — which is where the real
 * bug was found, a healthy Redis reported as down because a ping issued
 * mid-connect rejects immediately.
 */

const h = vi.hoisted(() => ({
  queryRawUnsafe: vi.fn(),
  contestCount: vi.fn(),
  assessmentCount: vi.fn(),
  redis: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    $queryRawUnsafe: h.queryRawUnsafe,
    contest: { count: h.contestCount },
    assessment: { count: h.assessmentCount },
  },
}));

vi.mock("@/lib/redis", () => ({ redis: h.redis }));

const { GET } = await import("@/app/api/health/route");

/** A Redis client stub that is ready and answers PING. */
function liveRedis() {
  return {
    status: "ready",
    ping: async () => "PONG",
    once: () => undefined,
    off: () => undefined,
  };
}

async function read(): Promise<{ status: number; body: HealthReport; cacheControl: string | null }> {
  const response = await GET();
  return {
    status: response.status,
    body: (await response.json()) as HealthReport,
    cacheControl: response.headers.get("cache-control"),
  };
}

describe("the database is down", () => {
  it("answers 200 with ok: false and db: down", async () => {
    h.queryRawUnsafe.mockRejectedValue(new Error("ECONNREFUSED"));
    h.redis.mockReturnValue(liveRedis());

    const { status, body, cacheControl } = await read();

    expect(status, "a 200 says 'I answered'; the body says what is wrong").toBe(200);
    expect(body.ok).toBe(false);
    expect(body.db).toBe("down");
    expect(cacheControl, "a cached health check is not a health check").toBe("no-store");
  });

  it("does not claim a contest is live when it cannot look", async () => {
    /**
     * `activeContest` gates deploys. With the database unreachable the honest
     * answer is "no contest I know of", and the deploy script's own
     * `FORCE_DEPLOY` is the lever for the case where somebody must act
     * anyway — guessing `true` here would block every deploy during an
     * outage, which is exactly when one is needed.
     */
    h.queryRawUnsafe.mockRejectedValue(new Error("ECONNREFUSED"));
    h.redis.mockReturnValue(liveRedis());

    const { body } = await read();

    expect(body.activeContest).toBe(false);
    expect(body.activeAssessment).toBe(false);
    expect(body.activeContests).toBe(0);
    expect(body.migrations, "unknown, not 'current'").toBe("unknown");
    expect(h.contestCount, "the contest count is not attempted with the database down").not.toHaveBeenCalled();
  });
});

describe("Redis is down", () => {
  it("answers 200 with ok: false and redis: down, and still reports the database", async () => {
    h.queryRawUnsafe.mockResolvedValue([{ n: 0n }]);
    h.contestCount.mockResolvedValue(0);
    h.assessmentCount.mockResolvedValue(0);
    h.redis.mockImplementation(() => {
      throw new Error("Redis is not configured");
    });

    const { status, body } = await read();

    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.redis).toBe("down");
    expect(body.db, "one dependency being down does not hide the other").toBe("up");
  });
});

describe("a live contest", () => {
  it("is reported by the clock, not by a status column", async () => {
    // A contest whose window is open is live whether or not a job has got
    // around to updating anything, and a deploy during that window is the
    // thing being prevented.
    h.queryRawUnsafe.mockResolvedValue([{ n: 9_999n }]);
    h.contestCount.mockResolvedValue(1);
    h.assessmentCount.mockResolvedValue(0);
    h.redis.mockReturnValue(liveRedis());

    const { body } = await read();

    expect(body.activeContest).toBe(true);
    expect(body.activeContests).toBe(1);
    expect(body.activeAssessment).toBe(false);
    const where = h.contestCount.mock.calls[0]?.[0]?.where as { startsAt?: unknown; endsAt?: unknown };
    expect(Object.keys(where).sort(), "the window, and nothing else").toEqual(["endsAt", "startsAt"]);
  });

  it("says nothing a visitor could not infer: no names, no ids, no slugs", async () => {
    /**
     * The endpoint is unauthenticated, so the body is a closed set of
     * fields: two booleans, two counts, three states and a version string.
     * `activeContests` is a COUNT because an operator needs to know whether
     * something is running and a stranger must not learn which.
     */
    h.queryRawUnsafe.mockResolvedValue([{ n: 9_999n }]);
    h.contestCount.mockResolvedValue(2);
    h.assessmentCount.mockResolvedValue(1);
    h.redis.mockReturnValue(liveRedis());

    const { body } = await read();

    expect(Object.keys(body).sort()).toEqual([
      "activeAssessment",
      "activeAssessments",
      "activeContest",
      "activeContests",
      "db",
      "migrations",
      "ok",
      "redis",
      "version",
    ]);
    const serialised = JSON.stringify(body);
    for (const leak of ["slug", "title", "name", "id", "user", "email"]) {
      expect(serialised.toLowerCase(), `the body mentions ${leak}`).not.toContain(leak);
    }
  });
});
