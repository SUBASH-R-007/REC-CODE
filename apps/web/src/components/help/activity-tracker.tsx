"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ACTIVITY_ENDPOINT, ACTIVITY_POLICY, crossesUnlock } from "@/lib/help/activity-policy";

const TICK_MS = 1_000;
/** A late or throttled tick never back-fills more than this. */
const MAX_TICK_MS = 2 * TICK_MS;

/**
 * Counts active seconds on a problem — the tab is visible AND the student
 * pressed a key or used the pointer within the last minute — and reports
 * them to POST /api/activity every 30 s and when the page is hidden or left
 * (sendBeacon). The server decides what to credit (src/lib/help/activity.ts);
 * this is only the meter. Renders nothing.
 *
 * When a ping carries the problem's total past a hint / editorial time
 * threshold, the page is refreshed so the help panels show the unlock.
 */
export function ActivityTracker({ problemId }: { problemId: string }) {
  const router = useRouter();

  useEffect(() => {
    /** Active seconds not yet accepted by the server (fractional). */
    let pending = 0;
    let lastInteraction = Date.now();
    let lastTick = Date.now();
    /** When the last ping left (ms); the server accepts one per 20 s. */
    let lastSentAt = 0;
    let inFlight = false;
    /** Signed out, cross-site or unknown problem: stop reporting. */
    let stopped = false;
    /** The server's total after the last accepted ping. */
    let known: number | null = null;

    const body = (seconds: number) => JSON.stringify({ problemId, seconds });

    const tick = () => {
      const now = Date.now();
      const dt = Math.min(Math.max(0, now - lastTick), MAX_TICK_MS);
      lastTick = now;
      const active =
        document.visibilityState === "visible" && now - lastInteraction <= ACTIVITY_POLICY.idleAfterMs;
      if (active) pending = Math.min(pending + dt / 1000, ACTIVITY_POLICY.maxCreditSeconds);
    };

    const ping = async (seconds: number) => {
      if (inFlight || stopped) return;
      inFlight = true;
      lastSentAt = Date.now();
      try {
        const response = await fetch(ACTIVITY_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          keepalive: true,
          body: body(seconds),
        });
        if (response.ok) {
          const data = (await response.json().catch(() => null)) as
            | { activeSeconds?: unknown; deferred?: unknown }
            | null;
          // 202 deferred: inside the server's 20 s window — keep the seconds.
          if (data?.deferred !== true) pending = Math.max(0, pending - seconds);
          const total = typeof data?.activeSeconds === "number" ? data.activeSeconds : null;
          if (total !== null) {
            if (known !== null && crossesUnlock(known, total)) router.refresh();
            known = total;
          }
        } else if (response.status === 401 || response.status === 403 || response.status === 404) {
          stopped = true;
        }
        // 5xx: keep the seconds for the next ping.
      } catch {
        // Offline: keep the seconds for the next ping.
      } finally {
        inFlight = false;
      }
    };

    const periodic = () => {
      tick();
      const seconds = Math.floor(pending);
      if (seconds < 1 || Date.now() - lastSentAt < ACTIVITY_POLICY.minPingGapMs) return;
      void ping(seconds);
    };

    /** Last chance before the page goes away or out of sight. */
    const flush = () => {
      tick();
      const seconds = Math.floor(pending);
      if (stopped || inFlight || seconds < 1 || Date.now() - lastSentAt < ACTIVITY_POLICY.minPingGapMs) return;
      lastSentAt = Date.now();
      pending -= seconds;
      const payload = body(seconds);
      const queued = typeof navigator.sendBeacon === "function" && navigator.sendBeacon(ACTIVITY_ENDPOINT, payload);
      if (!queued) {
        void fetch(ACTIVITY_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          keepalive: true,
          body: payload,
        }).catch(() => undefined);
      }
    };

    const interacted = () => {
      lastInteraction = Date.now();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
      else lastTick = Date.now();
    };

    const listen = { capture: true, passive: true } as const;
    const inputs = ["keydown", "pointerdown", "pointermove", "wheel"] as const;
    for (const type of inputs) window.addEventListener(type, interacted, listen);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flush);
    const ticker = window.setInterval(tick, TICK_MS);
    const pinger = window.setInterval(periodic, ACTIVITY_POLICY.pingIntervalMs);

    // Start the server-side clock for this problem (credits nothing).
    void ping(0);

    return () => {
      flush();
      window.clearInterval(ticker);
      window.clearInterval(pinger);
      for (const type of inputs) window.removeEventListener(type, interacted, listen);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
    };
  }, [problemId, router]);

  return null;
}
