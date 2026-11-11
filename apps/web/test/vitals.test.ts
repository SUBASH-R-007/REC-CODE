import { describe, expect, it, vi } from "vitest";
import {
  VITALS_SAMPLE_RATE,
  VITALS_TTL_SECONDS,
  VITAL_BUCKETS,
  VITAL_METRICS,
  VITAL_ROUTES,
  vitalBucket,
  vitalPercentile,
  vitalRouteOf,
  vitalsKey,
} from "@recx/shared";

/**
 * `POST /api/vitals` (Phase 10d).
 *
 * The gate item: *"/api/vitals stores no user id, accepts only the three
 * fields, and is rate limited."* The first of those is the one worth a test
 * rather than a code review, because it is the kind of thing a later
 * "improvement" adds — a `userId` in the key would make "which students see
 * a slow editor" answerable, and would turn a performance histogram into a
 * browsing history.
 */

const h = vi.hoisted(() => ({
  hincrby: vi.fn(),
  expire: vi.fn(),
  hitRateLimit: vi.fn(),
  ipHash: vi.fn(),
}));

vi.mock("@/lib/redis", () => ({ redis: () => ({ hincrby: h.hincrby, expire: h.expire }) }));
vi.mock("@/lib/ip", () => ({ requestIpHash: h.ipHash }));
vi.mock("@/lib/rate-limit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rate-limit")>("@/lib/rate-limit");
  return { ...actual, hitRateLimit: h.hitRateLimit };
});

const { POST } = await import("@/app/api/vitals/route");

function beacon(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/vitals", {
    method: "POST",
    headers: { "content-type": "text/plain", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function reset(options: { allowed?: boolean; ipHash?: string | null } = {}) {
  h.hincrby.mockReset().mockResolvedValue(1);
  h.expire.mockReset().mockResolvedValue(1);
  h.hitRateLimit.mockReset().mockResolvedValue({ allowed: options.allowed ?? true, remaining: 10, retryAfterMs: 0 });
  h.ipHash.mockReset().mockResolvedValue(options.ipHash === undefined ? "ip-hash-abc" : options.ipHash);
}

describe("what it stores", () => {
  it("increments one bucket of one histogram, keyed by day, metric and route", async () => {
    reset();
    const response = await POST(beacon({ metric: "LCP", value: 1900, route: "/problems/[slug]" }));

    expect(response.status, "a beacon has nobody to report a status to").toBe(204);
    expect(h.hincrby).toHaveBeenCalledTimes(1);
    const [key, bucket, by] = h.hincrby.mock.calls[0]!;
    expect(key).toMatch(/^vitals:\d{4}-\d{2}-\d{2}:LCP:\/problems\/\[slug\]$/);
    expect(bucket, "1,900 ms lands in the 2,000 ms bucket").toBe("2000");
    expect(by).toBe(1);
  });

  it("puts no identity in the key, and nothing else about the sender", async () => {
    /**
     * The assertion this file exists for. The hashed address is computed —
     * the rate limiter needs it — and must not reach the key; the raw
     * address is never computed at all, anywhere in this platform.
     */
    reset({ ipHash: "ip-hash-abc" });
    await POST(beacon({ metric: "CLS", value: 0.03, route: "/dashboard" }));

    const key = String(h.hincrby.mock.calls[0]?.[0]);
    for (const forbidden of ["ip-hash-abc", "user", "session", "student", "email", "college"]) {
      expect(key.toLowerCase(), `the key mentions ${forbidden}`).not.toContain(forbidden);
    }
    expect(key).toBe(vitalsKey(key.split(":")[1]!, "CLS", "/dashboard"));
  });

  it("sets the retention on every write, so retention is a property of the data", async () => {
    reset();
    await POST(beacon({ metric: "INP", value: 120, route: "/leaderboard" }));
    expect(h.expire).toHaveBeenCalledWith(expect.stringContaining("vitals:"), VITALS_TTL_SECONDS);
    // Five weeks: long enough to compare a contest week with a quiet one,
    // short enough that nothing outlives the question it was collected for.
    expect(VITALS_TTL_SECONDS).toBe(35 * 24 * 60 * 60);
  });
});

describe("what it refuses, silently", () => {
  const rejected: Array<[string, unknown]> = [
    ["an unknown metric", { metric: "FID", value: 10, route: "/dashboard" }],
    ["an unknown route", { metric: "LCP", value: 10, route: "/admin" }],
    ["a dynamic path instead of its pattern", { metric: "LCP", value: 10, route: "/problems/two-sum" }],
    ["a fourth field", { metric: "LCP", value: 10, route: "/dashboard", userId: "u_1" }],
    ["a missing field", { metric: "LCP", route: "/dashboard" }],
    ["a value that is not a number", { metric: "LCP", value: "1900", route: "/dashboard" }],
    ["a negative value", { metric: "LCP", value: -1, route: "/dashboard" }],
    ["an absurd value", { metric: "LCP", value: 10_000_000, route: "/dashboard" }],
    ["NaN", { metric: "LCP", value: Number.NaN, route: "/dashboard" }],
    ["an array", [{ metric: "LCP", value: 10, route: "/dashboard" }]],
    ["a string body", "LCP=1900"],
  ];

  for (const [what, body] of rejected) {
    it(`drops ${what} and writes nothing`, async () => {
      reset();
      const response = await POST(beacon(body));
      expect(response.status, "204 for everything, so nothing can be enumerated").toBe(204);
      expect(h.hincrby, what).not.toHaveBeenCalled();
    });
  }

  it("drops a body over the size cap without parsing it", async () => {
    reset();
    const response = await POST(beacon("x".repeat(4096), { "content-length": "4096" }));
    expect(response.status).toBe(204);
    expect(h.hincrby).not.toHaveBeenCalled();
  });

  it("refuses a userId even when every other field is valid", async () => {
    // The shape a later "improvement" would arrive in: the endpoint must
    // reject the extra key rather than ignore it, so the addition cannot
    // start working silently.
    reset();
    await POST(beacon({ metric: "LCP", value: 1000, route: "/dashboard", userId: "u_1" }));
    expect(h.hincrby).not.toHaveBeenCalled();
  });
});

describe("the rate limit", () => {
  it("is per hashed address, and a refusal writes nothing", async () => {
    reset({ allowed: false });
    const response = await POST(beacon({ metric: "LCP", value: 1000, route: "/dashboard" }));

    expect(response.status).toBe(204);
    expect(h.hitRateLimit).toHaveBeenCalledWith("vitals:ip-hash-abc", expect.objectContaining({ limit: 120 }));
    expect(h.hincrby).not.toHaveBeenCalled();
  });

  it("still records when the address cannot be hashed", async () => {
    /**
     * `requestIpHash()` returns null when there is no forwarded address to
     * hash (a direct container-to-container request, a misconfigured proxy).
     * Dropping the report would silently lose a whole deployment's data;
     * what is lost instead is the per-address budget, and the metric and
     * route lists still bound what can be written.
     */
    reset({ ipHash: null });
    await POST(beacon({ metric: "TTFB", value: 300, route: "/profile" }));
    expect(h.hitRateLimit).not.toHaveBeenCalled();
    expect(h.hincrby).toHaveBeenCalledTimes(1);
  });

  it("answers 204 when Redis is unreachable", async () => {
    reset();
    h.hincrby.mockRejectedValue(new Error("ECONNREFUSED"));
    const response = await POST(beacon({ metric: "FCP", value: 700, route: "/sheets" }));
    // A vitals write that fails is a missing data point, never a failed page
    // load — and the beacon is sent from a document being torn down, so
    // there is nothing to retry into.
    expect(response.status).toBe(204);
  });
});

describe("the contract the browser and the endpoint share", () => {
  it("maps a pathname to its route pattern, or to nothing", () => {
    expect(vitalRouteOf("/dashboard")).toBe("/dashboard");
    expect(vitalRouteOf("/problems/two-sum")).toBe("/problems/[slug]");
    expect(vitalRouteOf("/contests/sprint-1/")).toBe("/contests/[slug]");
    // One segment only: a problem's submissions list is a different page.
    expect(vitalRouteOf("/problems/two-sum/submissions")).toBeNull();
    expect(vitalRouteOf("/admin/students")).toBeNull();
    expect(vitalRouteOf("/exam/attempt-1")).toBeNull();
    // Zero-JavaScript by requirement, so nothing there can measure anything.
    expect(vitalRouteOf("/login")).toBeNull();
  });

  it("samples one page load in four", () => {
    expect(VITALS_SAMPLE_RATE).toBe(0.25);
  });

  it("gives every metric a bucket ladder with the budget as a boundary", () => {
    for (const metric of VITAL_METRICS) {
      const ladder = VITAL_BUCKETS[metric];
      expect(ladder.length, metric).toBeGreaterThan(4);
      expect([...ladder].sort((a, b) => a - b), `${metric}'s ladder is out of order`).toEqual([...ladder]);
    }
    // docs/CAPACITY.md: LCP ≤2.0 s, ≤2.5 s on the statement page. Both are
    // boundaries, so "p75 within budget" is answerable without interpolating
    // across one.
    expect(VITAL_BUCKETS.LCP).toContain(2000);
    expect(VITAL_BUCKETS.LCP).toContain(2500);
    // CLS's "good" and "poor" thresholds.
    expect(VITAL_BUCKETS.CLS).toContain(0.1);
    expect(VITAL_BUCKETS.CLS).toContain(0.25);
  });

  it("buckets a value into the first boundary it is at or under", () => {
    expect(vitalBucket("LCP", 0)).toBe("100");
    expect(vitalBucket("LCP", 2000)).toBe("2000");
    expect(vitalBucket("LCP", 2001)).toBe("2500");
    // A 40-second LCP is real — a phone on campus wifi during a contest —
    // and must not be rounded into the top finite bucket.
    expect(vitalBucket("LCP", 40_000)).toBe("+Inf");
  });

  it("reports a percentile as the bucket it falls in, and null for no data", () => {
    const counts = { "100": 10, "200": 10, "400": 10, "800": 10, "1200": 10 };
    const p75 = vitalPercentile("LCP", counts);
    expect(p75).toEqual({ bucket: "800", atOrBelow: 40, total: 50 });
    // Not zero: "nothing was reported" and "everything was instant" are
    // different answers, and a dashboard must not show the second for the
    // first.
    expect(vitalPercentile("LCP", {})).toBeNull();
  });

  it("samples a closed list of routes, all of them student pages", () => {
    expect(VITAL_ROUTES.length).toBeGreaterThan(8);
    for (const route of VITAL_ROUTES) {
      expect(route.startsWith("/"), route).toBe(true);
      for (const staff of ["/admin", "/super", "/placement-cell", "/mentor", "/exam"]) {
        expect(route.startsWith(staff), `${route} is a staff or exam route`).toBe(false);
      }
    }
  });
});
