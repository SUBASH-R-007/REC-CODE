"use client";

import {
  EVENT_FLUSH_COUNT,
  shouldFlush,
  type ClientProctorEvent,
  type ProctorEventBatchResponse,
} from "@recx/shared";

/**
 * The client's telemetry queue (Phase 6c).
 *
 * SPEC §5: "Flush on a 5s tick or 25 events, and via navigator.sendBeacon on
 * pagehide/visibilitychange→hidden with a fetch(..., {keepalive: true})
 * fallback."
 *
 * The monotonic `clientSeq` is the part that matters most, and it is why this
 * is a class with one counter rather than a hook per event source. SPEC §5:
 *
 *   The monotonic clientSeq plus the server watermark is what makes
 *   suppression detectable: an extension that filters events leaves a hole
 *   the server records as SEQUENCE_GAP, and one that blocks the reporting
 *   channel leaves zeros in a bitmap the server owns.
 *
 * So the counter increments when an event is CREATED, not when it is sent. An
 * event dropped on the floor still consumed its number, and the hole is
 * exactly the signal.
 *
 * Nothing here retries forever. A failed flush puts its events back at the
 * front of the queue once; if the queue grows past a bound the oldest are
 * dropped, because an exam client that has been offline for ten minutes
 * should spend its memory on the candidate's code, not on a backlog of
 * context-menu events. The gap that leaves is visible to the server.
 */

/** Past this, the oldest events are dropped rather than growing without bound. */
const MAX_QUEUED = EVENT_FLUSH_COUNT * 20;

export interface QueueCallbacks {
  /** Called with the server's answer to a successful flush. */
  readonly onResponse?: (response: ProctorEventBatchResponse) => void;
  /** Called when the attempt is over and the client should stop. */
  readonly onRevoked?: (reason: string) => void;
  readonly onTransportError?: () => void;
}

export class TelemetryQueue {
  private readonly url: string;
  private readonly callbacks: QueueCallbacks;
  private pending: ClientProctorEvent[] = [];
  private seq = 0;
  private lastFlushMs = 0;
  private inFlight = false;
  private stopped = false;
  /** Events the server never saw because the queue overflowed. */
  private droppedLocally = 0;

  constructor(attemptId: string, callbacks: QueueCallbacks = {}) {
    this.url = `/api/exam/${attemptId}/events`;
    this.callbacks = callbacks;
    this.lastFlushMs = TelemetryQueue.now();
  }

  private static now(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
  }

  /** The next sequence number. Consumed even if the event is never sent. */
  nextSeq(): number {
    return this.seq++;
  }

  get queued(): number {
    return this.pending.length;
  }

  get droppedCount(): number {
    return this.droppedLocally;
  }

  /** Enqueue an event. `clientSeq` is assigned here, in creation order. */
  add(event: Omit<ClientProctorEvent, "clientSeq">): void {
    if (this.stopped) return;
    this.pending.push({ ...event, clientSeq: this.nextSeq() });
    if (this.pending.length > MAX_QUEUED) {
      this.droppedLocally += this.pending.length - MAX_QUEUED;
      this.pending = this.pending.slice(-MAX_QUEUED);
    }
  }

  /** Should this tick send? The policy lives in @recx/shared. */
  due(pageHiding = false): boolean {
    if (this.stopped || this.inFlight) return false;
    return shouldFlush({
      pending: this.pending.length,
      msSinceLastFlush: TelemetryQueue.now() - this.lastFlushMs,
      pageHiding,
    });
  }

  stop(): void {
    this.stopped = true;
    this.pending = [];
  }

  /**
   * Send what is queued. At most one request at a time: a second concurrent
   * flush would interleave sequence numbers across two requests and make a
   * gap that was never real.
   */
  async flush(): Promise<void> {
    if (this.stopped || this.inFlight || this.pending.length === 0) return;
    const batch = this.pending.splice(0, EVENT_FLUSH_COUNT * 4);
    this.inFlight = true;
    this.lastFlushMs = TelemetryQueue.now();
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: batch }),
        // Same-origin only; the cookie and the attempt token travel with it.
        credentials: "same-origin",
      });
      if (response.status === 409) {
        const body = (await response.json().catch(() => ({}))) as { revokeReason?: string };
        this.stop();
        this.callbacks.onRevoked?.(body.revokeReason ?? "submitted");
        return;
      }
      if (!response.ok) {
        // 413 and 400 are OUR bug, not the candidate's, and re-sending the
        // same batch would fail the same way for ever. Dropped, and the
        // sequence hole records that something was lost.
        if (response.status === 413 || response.status === 400) {
          this.droppedLocally += batch.length;
          console.error(`[exam] telemetry batch refused with ${response.status}; ${batch.length} events dropped`);
          return;
        }
        throw new Error(`telemetry flush failed: ${response.status}`);
      }
      const body = (await response.json()) as ProctorEventBatchResponse;
      this.callbacks.onResponse?.(body);
    } catch {
      // Put them back at the FRONT, so order is preserved for the next try.
      this.pending = [...batch, ...this.pending].slice(-MAX_QUEUED);
      this.callbacks.onTransportError?.();
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * The last flush, as the page goes away. `sendBeacon` survives the
   * navigation where `fetch` does not; a keepalive fetch is the fallback for
   * browsers that refuse the beacon (it is capped at 64 KB, which is the same
   * ceiling the route enforces).
   *
   * Synchronous by necessity — `pagehide` does not wait for a promise.
   */
  flushOnHide(): void {
    if (this.stopped || this.pending.length === 0) return;
    const batch = this.pending.splice(0, EVENT_FLUSH_COUNT * 4);
    const body = JSON.stringify({ events: batch });
    const sent =
      typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function"
        ? navigator.sendBeacon(this.url, new Blob([body], { type: "text/plain" }))
        : false;
    if (sent) return;
    void fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
      credentials: "same-origin",
    }).catch(() => undefined);
  }
}
