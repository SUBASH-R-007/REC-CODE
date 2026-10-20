import { describe, expect, it } from "vitest";
import { readRepoFile } from "./support/repo";

/**
 * The performance budgets, in three places that must agree (Phase 10d).
 *
 * `docs/CAPACITY.md` §8 states the reference device's targets, `apps/web/
 * lighthouserc.json` enforces two of them, and `apps/web/size-budgets.json`
 * holds the bundle sizes. A number that drifts between the document and the
 * assertion is the same failure as a stale alert threshold: everything still
 * reviews fine, and the gate is measuring something nobody decided.
 *
 * This is a text check, and it is honest about that: it proves the numbers
 * are the same numbers, not that Lighthouse measures what the document
 * means.
 */

type Assertions = Record<string, unknown>;

interface LighthouseConfig {
  ci?: {
    assert?: { assertMatrix?: Array<{ matchingUrlPattern?: string; assertions?: Assertions }> };
    collect?: { url?: string[]; numberOfRuns?: number; settings?: Record<string, unknown> };
  };
}

const lighthouse = JSON.parse(readRepoFile("apps/web/lighthouserc.json")) as LighthouseConfig;
const capacity = readRepoFile("docs/CAPACITY.md").replace(/\r\n/g, "\n");
const workflow = readRepoFile(".github/workflows/ci.yml").replace(/\r\n/g, "\n");

/** Every per-URL assertion block. Budgets are per page: see the file's own note. */
const matrix = lighthouse.ci?.assert?.assertMatrix ?? [];

/** The assertion block for the URL pattern ending in `suffix`. */
function forPage(suffix: string): Assertions {
  const entry = matrix.find((row) => (row.matchingUrlPattern ?? "").endsWith(`${suffix}$`));
  expect(entry, `no assertions for ${suffix}`).toBeDefined();
  return entry!.assertions ?? {};
}

/** The numeric ceiling of an `["error", { maxNumericValue }]` assertion. */
function ceiling(assertions: Assertions, audit: string): number | null {
  const entry = assertions[audit];
  if (!Array.isArray(entry)) return null;
  const options = entry[1] as { maxNumericValue?: number } | undefined;
  return typeof options?.maxNumericValue === "number" ? options.maxNumericValue : null;
}

describe("Lighthouse enforces the numbers CAPACITY.md states", () => {
  it("holds /login to the 2.0 s LCP the document states", () => {
    expect(ceiling(forPage("/login"), "largest-contentful-paint")).toBe(2000);
    expect(capacity, "CAPACITY.md §8 states the LCP target").toContain("≤ 2.0 s");
  });

  it("holds /judge to 2.5 s, and the document says why", () => {
    /**
     * A per-page budget, not a loosening: /judge is a long server-rendered
     * document and measured 2,376 ms on the development laptop under the
     * reference device's throttling. A budget raised without a reason in
     * CAPACITY.md is a budget nobody chose, so the fence requires both.
     */
    expect(ceiling(forPage("/judge"), "largest-contentful-paint")).toBe(2500);
    expect(capacity).toContain("≤ 2.5 s");
    expect(capacity, "CAPACITY.md §8 has to name the page").toMatch(/\/judge/);
  });

  it("holds CLS to 0.1 on every audited page", () => {
    for (const row of matrix) {
      expect(ceiling(row.assertions ?? {}, "cumulative-layout-shift"), row.matchingUrlPattern).toBe(0.1);
    }
    expect(capacity).toContain("≤ 0.1");
  });

  it("fails on a console error, on every audited page", () => {
    // A page that logs an error has a bug a student can see the effects of;
    // this is the cheapest place in the pipeline that notices. It found one:
    // the platform had no favicon, so every page load 404'd on /favicon.ico.
    expect(matrix.length).toBeGreaterThan(1);
    for (const row of matrix) {
      expect(row.assertions?.["errors-in-console"], row.matchingUrlPattern).toBe("error");
    }
  });

  it("audits more than one run, so a single slow cold start is not the verdict", () => {
    expect(lighthouse.ci?.collect?.numberOfRuns ?? 0).toBeGreaterThanOrEqual(3);
    for (const row of matrix) {
      for (const assertion of Object.values(row.assertions ?? {})) {
        if (!Array.isArray(assertion)) continue;
        const options = assertion[1] as { maxNumericValue?: number; aggregationMethod?: string } | undefined;
        if (options?.maxNumericValue === undefined) continue;
        expect(options.aggregationMethod, "a numeric budget needs an aggregation across runs").toBe("median");
      }
    }
  });

  it("gives every audited URL its own assertions", () => {
    // An audited page with no matching pattern is audited and asserted
    // against nothing, which reads in the output as a passing page.
    for (const url of lighthouse.ci?.collect?.url ?? []) {
      const path = new URL(url).pathname;
      expect(
        matrix.some((row) => new RegExp(row.matchingUrlPattern ?? "$^").test(url)),
        `${path} has no assertion block`,
      ).toBe(true);
    }
  });

  it("throttles to the reference device's network, not to a laptop's", () => {
    const throttling = lighthouse.ci?.collect?.settings?.throttling as
      | { cpuSlowdownMultiplier?: number; downloadThroughputKbps?: number; rttMs?: number }
      | undefined;
    // docs/CAPACITY.md §8: ~4x CPU, 3 Mbps down, 150 ms RTT.
    expect(throttling?.cpuSlowdownMultiplier).toBe(4);
    expect(throttling?.downloadThroughputKbps).toBe(3000);
    expect(throttling?.rttMs).toBe(150);
    expect(capacity).toContain("3 Mbps down, 1 Mbps up, 150 ms RTT");
  });

  it("audits only pages a visitor can reach without a session", () => {
    /**
     * Lighthouse holds no session, so an audited page behind a guard would
     * be measuring the redirect to `/login`. The workspace's own budget is
     * enforced by the `perf` Playwright project, which signs in.
     */
    const urls = lighthouse.ci?.collect?.url ?? [];
    expect(urls.length).toBeGreaterThan(1);
    for (const url of urls) {
      const path = new URL(url).pathname;
      /**
       * `/problems` is in this list because the first version of the config
       * audited it: it redirects to `/login`, so every run measured the
       * sign-in page and the only sign was the run count. A redirect is the
       * quietest way for a performance gate to measure the wrong page.
       */
      for (const guarded of ["/admin", "/super", "/placement-cell", "/mentor", "/dashboard", "/profile", "/problems", "/leaderboard"]) {
        expect(path.startsWith(guarded), `${path} needs a session`).toBe(false);
      }
    }
  });
});

describe("CI runs it", () => {
  it("has a Lighthouse job of its own", () => {
    // Its own job because Lighthouse is slow and flaky under contention, and
    // a flaky gate sharing a job with the axe one makes people re-run both.
    expect(workflow).toContain("@lhci/cli");
    expect(workflow).toMatch(/^ {2}lighthouse:$/m);
    expect(workflow).toMatch(/^ {2}e2e:$/m);
  });

  it("builds for production before measuring", () => {
    // A `next dev` timing says nothing about production: CAPACITY.md §7.3
    // records how little.
    const job = workflow.slice(workflow.indexOf("\n  lighthouse:"));
    expect(job).toContain("pnpm --filter @recx/web build");
    // The server command lives in lighthouserc.json so the same numbers can
    // be run by hand; the job only has to build first.
    expect(JSON.stringify(lighthouse.ci?.collect)).toContain("next start");
  });
});

describe("the bundle budgets are numbers somebody chose", () => {
  const budgets = JSON.parse(readRepoFile("apps/web/size-budgets.json")) as {
    routes?: Array<{ route?: string; maxKb?: number; entry?: string; page?: string }>;
  };

  it("gives every budgeted route a finite ceiling and something to measure", () => {
    const routes = budgets.routes ?? [];
    expect(routes.length).toBeGreaterThan(10);
    for (const row of routes) {
      expect(typeof row.route, "a budget row with no route").toBe("string");
      expect(Number.isFinite(row.maxKb), `${row.route} has no numeric budget`).toBe(true);
      expect(row.maxKb, `${row.route}'s budget is not a ceiling`).toBeGreaterThan(0);
      // `entry` is an App Router route, `page` a Pages Router one. Without
      // either there is nothing to measure and the row is decoration.
      expect(Boolean(row.entry ?? row.page), `${row.route} names nothing to measure`).toBe(true);
    }
  });

  it("budgets the student shell's own pages, which now carry the vitals reporter", () => {
    const routes = budgets.routes ?? [];
    for (const route of ["/dashboard", "/problems", "/problems/[slug] shell"]) {
      expect(
        routes.some((row) => row.route === route),
        `${route} is unbudgeted`,
      ).toBe(true);
    }
  });
});
