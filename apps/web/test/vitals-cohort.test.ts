import { describe, expect, it, vi } from "vitest";
import {
  VITAL_COHORT_UNKNOWN,
  VITAL_COHORT_YEARS_BACK,
  VITAL_COHORT_YEARS_FORWARD,
  campusDay,
  cohortKeyFor,
  isVitalCohort,
  vitalsCohortKey,
  vitalsKey,
} from "@recx/shared";

/**
 * Field vitals by cohort (Phase 16l, `docs/ROADMAP.md` §3.4).
 *
 * The entry asked for a cohort instead of a user id, and the thing worth
 * testing is not that a second Redis key exists — it is the two properties
 * that make the addition safe:
 *
 *   1. the unlabelled histogram is written whatever happens, so every
 *      budget and every reader from before this phase sees exactly what it
 *      saw before, and a report with no cohort still counts;
 *   2. the caller never chooses the key. The cohort is a batch year inside
 *      a closed window, like `VITAL_ROUTES` is a closed list, because this
 *      endpoint is unauthenticated.
 *
 * There is still no user id anywhere in it, which the Phase 10d test
 * asserts and this one does not weaken.
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

function beacon(body: unknown): Request {
  return new Request("http://localhost/api/vitals", {
    method: "POST",
    headers: { "content-type": "text/plain;charset=UTF-8" },
    body: JSON.stringify(body),
  });
}

function reset() {
  h.hincrby.mockReset();
  h.expire.mockReset();
  h.ipHash.mockReset();
  h.ipHash.mockResolvedValue(null);
  h.hitRateLimit.mockReset();
  h.hitRateLimit.mockResolvedValue({ allowed: true, retryAfterMs: 0, key: "k" });
}

const YEAR = new Date().getUTCFullYear();
const DAY = campusDay(new Date());

describe("the cohort a report may name", () => {
  it("is the batch year, and the same definition the percentiles use", () => {
    // One definition of "cohort", not two: `cohortKeyFor` already decided
    // batch-and-not-department, and said why.
    expect(cohortKeyFor(2027)).toBe("2027");
    expect(cohortKeyFor(null)).toBe(VITAL_COHORT_UNKNOWN);
    expect(isVitalCohort(cohortKeyFor(YEAR), YEAR)).toBe(true);
    expect(isVitalCohort(cohortKeyFor(null), YEAR)).toBe(true);
  });

  it("accepts a year inside the window and refuses one outside it", () => {
    expect(isVitalCohort(String(YEAR - VITAL_COHORT_YEARS_BACK), YEAR)).toBe(true);
    expect(isVitalCohort(String(YEAR + VITAL_COHORT_YEARS_FORWARD), YEAR)).toBe(true);
    expect(isVitalCohort(String(YEAR - VITAL_COHORT_YEARS_BACK - 1), YEAR)).toBe(false);
    expect(isVitalCohort(String(YEAR + VITAL_COHORT_YEARS_FORWARD + 1), YEAR)).toBe(false);
  });

  it("refuses anything that is not a four-digit year or UNKNOWN", () => {
    for (const bad of ["", "20270", "202", "27", "two thousand", "2027; DROP", "*", null, undefined, 2027, {}]) {
      expect(isVitalCohort(bad, YEAR), String(bad)).toBe(false);
    }
  });
});

describe("the keys", () => {
  it("keep the unlabelled key byte-for-byte what it was", () => {
    // Phase 10d's key shape, unchanged. A reader from before this phase
    // must not have to know the cohort exists.
    expect(vitalsKey("2026-11-10", "LCP", "/dashboard")).toBe("vitals:2026-11-10:LCP:/dashboard");
  });

  it("put the cohort in its own key, under a segment nothing else uses", () => {
    expect(vitalsCohortKey("2026-11-10", "LCP", "/dashboard", "2027")).toBe(
      "vitals:2026-11-10:LCP:/dashboard:c:2027",
    );
    // And the two never collide, whatever the route is called.
    expect(vitalsCohortKey("2026-11-10", "LCP", "/dashboard", "2027")).not.toBe(
      vitalsKey("2026-11-10", "LCP", "/dashboard"),
    );
  });
});

describe("POST /api/vitals with a cohort", () => {
  it("writes the unlabelled histogram AND the cohort one", async () => {
    reset();
    const response = await POST(beacon({ metric: "LCP", route: "/dashboard", value: 2200, cohort: String(YEAR) }));
    expect(response.status).toBe(204);

    const keys = h.hincrby.mock.calls.map(([key]) => key as string);
    expect(keys).toEqual([
      vitalsKey(DAY, "LCP", "/dashboard"),
      vitalsCohortKey(DAY, "LCP", "/dashboard", String(YEAR)),
    ]);
    // The same bucket in both, and a TTL set on both.
    expect(new Set(h.hincrby.mock.calls.map(([, bucket]) => bucket as string)).size).toBe(1);
    expect(h.expire.mock.calls.map(([key]) => key as string)).toEqual(keys);
  });

  it("writes only the unlabelled one when no cohort is sent", async () => {
    reset();
    await POST(beacon({ metric: "INP", route: "/problems", value: 120 }));
    expect(h.hincrby.mock.calls.map(([key]) => key as string)).toEqual([vitalsKey(DAY, "INP", "/problems")]);
  });

  it("drops a cohort outside the window but still counts the sample", async () => {
    // The unlabelled histogram is what every budget is read from, so a
    // label this endpoint will not store must not cost the measurement.
    reset();
    await POST(beacon({ metric: "CLS", route: "/leaderboard", value: 0.05, cohort: "1999" }));
    expect(h.hincrby.mock.calls.map(([key]) => key as string)).toEqual([vitalsKey(DAY, "CLS", "/leaderboard")]);
  });

  it("refuses a fifth key, and a fourth that is not the cohort", async () => {
    reset();
    await POST(beacon({ metric: "LCP", route: "/dashboard", value: 1000, cohort: String(YEAR), extra: 1 }));
    expect(h.hincrby).not.toHaveBeenCalled();

    reset();
    await POST(beacon({ metric: "LCP", route: "/dashboard", value: 1000, userId: "u_1" }));
    expect(h.hincrby).not.toHaveBeenCalled();
  });

  it("still stores no user id, in either key", async () => {
    reset();
    await POST(beacon({ metric: "TTFB", route: "/profile", value: 300, cohort: String(YEAR) }));
    const everything = JSON.stringify([...h.hincrby.mock.calls, ...h.expire.mock.calls]);
    for (const forbidden = "userId", also = "session"; ; ) {
      expect(everything).not.toContain(forbidden);
      expect(everything).not.toContain(also);
      break;
    }
    // The cohort is a year, and a year is not a person.
    expect(everything).toContain(String(YEAR));
  });
});
