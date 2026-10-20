"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { VITALS_SAMPLE_RATE, vitalRouteOf, type VitalMetric } from "@recx/shared";

/**
 * Field vitals, from one in four page loads (Phase 10d).
 *
 * Mounted in the student shell, which is what keeps it out of the exam
 * surface: `app/(exam)` is its own route group with its own layout, so a
 * proctored attempt sends no beacons at all. That is deliberate — a locked
 * down page should make exactly the requests its own protocol describes, and
 * a stray POST during an attempt is a thing an invigilator would have to
 * explain.
 *
 * It reports a METRIC, a VALUE and a ROUTE PATTERN. There is no user id,
 * here or at the endpoint, so this cannot become a record of which pages a
 * student visited and when.
 *
 * **The attribution, stated because it is a real limitation.** LCP, FCP and
 * TTFB are document-level, and CLS and INP accumulate across a document's
 * life. So the handlers are registered ONCE per document and every metric is
 * attributed to the route the document was LOADED with, not to whichever
 * route happened to be open when the browser finalised the number. For a
 * platform people enter at `/dashboard` and navigate within, that means a
 * client-side navigation's layout shift lands on `/dashboard`. The
 * alternative — re-registering per navigation — double-counts and is worse.
 */

const ENDPOINT = "/api/vitals";

function send(metric: VitalMetric, value: number, route: string): void {
  const body = JSON.stringify({ metric, value, route });
  try {
    /**
     * `sendBeacon` because the page is usually being unloaded when a metric
     * finalises: a `fetch` from a document the browser is tearing down is
     * cancelled, which is how a vitals pipeline ends up reporting only the
     * page views nobody left. `text/plain` keeps it a simple request, so
     * there is no preflight and no CORS surface.
     */
    const blob = new Blob([body], { type: "text/plain;charset=UTF-8" });
    if (navigator.sendBeacon?.(ENDPOINT, blob)) return;
  } catch {
    // Fall through to fetch.
  }
  // `keepalive` is the fallback for browsers where sendBeacon is missing or
  // refuses (it has a queue limit). Failure is silence: a missing data point
  // must never surface to a student.
  void fetch(ENDPOINT, { method: "POST", body, keepalive: true, headers: { "content-type": "text/plain" } }).catch(
    () => undefined,
  );
}

export function VitalsReporter(): null {
  const pathname = usePathname();

  useEffect(() => {
    // Once per document: see the attribution note above.
    const route = vitalRouteOf(pathname ?? "/");
    if (!route) return;
    if (Math.random() >= VITALS_SAMPLE_RATE) return;

    let cancelled = false;
    void (async () => {
      /**
       * Imported dynamically so `web-vitals` is a separate chunk that the
       * three unsampled page loads out of four never fetch — and so it is
       * never in the student shell's own bundle, which `size-budgets.json`
       * holds to a number.
       */
      const { onCLS, onFCP, onINP, onLCP, onTTFB } = await import("web-vitals");
      if (cancelled) return;
      const report = (metric: VitalMetric) => (entry: { value: number }) => {
        if (!cancelled) send(metric, entry.value, route);
      };
      onLCP(report("LCP"));
      onCLS(report("CLS"));
      onINP(report("INP"));
      onFCP(report("FCP"));
      onTTFB(report("TTFB"));
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per document, by design
  }, []);

  return null;
}
