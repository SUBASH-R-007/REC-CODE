import {
  EXAM_BROWSER_SIGNALS_PATH,
  EXAM_BROWSER_SIGNAL_BATCH_MAX,
  type ExamBrowserSignal,
  type ExamBrowserSignalKind,
} from "@recx/shared/exam-browser";

/**
 * What this window saw, on its way to the server (Phase 15a).
 *
 * The page already tells the server when it loses focus, leaves
 * fullscreen or sees a second monitor. `docs/PROCTORING.md` §2 is explicit
 * that all three are falsifiable, because the exam page is the one place
 * in this product a candidate can run their own JavaScript: the console is
 * gone, but a paste into an editor component runs in the same world. This
 * process is a different witness. It signs with a key the page never sees,
 * so what it reports cannot be forged by a script in the window and --
 * the part that matters more -- cannot be silenced by one.
 *
 * Everything here is a queue and a clock, deliberately. The decisions are
 * in `policy.ts` with the rest of them, and the only reason this is its
 * own file is that a queue with a timer in it is the kind of thing that
 * grows a bug nobody can reproduce unless it can be driven by hand in a
 * test.
 *
 * What it is NOT, and the fence checks: it records nothing about what is
 * on a screen, which key was pressed, or which application took the
 * focus. A count, a duration and a kind. `docs/PROCTORING.md` §5 forbids
 * screen capture and content keylogging by name, and an "improvement" to
 * this file is exactly how a product acquires them by accident.
 */

/** How often a non-empty queue is flushed. */
export const SIGNAL_FLUSH_INTERVAL_MS = 15_000;

/**
 * Focus flickers shorter than this are dropped before they are queued.
 *
 * A notification, a tooltip or the window manager repainting takes the
 * focus for a few hundred milliseconds. The server drops these too, which
 * is belt and braces rather than duplication -- doing it here as well
 * means a candidate on a chatty machine does not spend their paper
 * uploading noise.
 */
export const FOCUS_NOISE_MS = 1_000;

/**
 * The most that is ever held in memory. Past this the OLDEST are dropped,
 * not the newest: a sitting that has been flapping for an hour is better
 * described by what it is doing now than by how it started, and the first
 * few are already on the server from an earlier flush.
 */
export const SIGNAL_QUEUE_MAX = 256;

export interface SignalSink {
  /** Resolves true when the batch was accepted and may be forgotten. */
  readonly post: (url: string, body: string) => Promise<boolean>;
}

export interface SignalQueueDeps {
  readonly sink: SignalSink;
  /** The exam origin; the path is fixed. */
  readonly origin: () => string | null;
  readonly now: () => number;
  /** Where the window opened, so `atMs` is measured from something real. */
  readonly startedAtMs: number;
  readonly onError?: (name: string) => void;
}

/**
 * A queue that batches signals and flushes them.
 *
 * Failure is survivable by design: a batch that does not post goes back to
 * the front of the queue and is tried again on the next flush. The server
 * deduplicates, so a batch delivered twice costs nothing, and a batch
 * never delivered costs a line in a timeline rather than a candidate's
 * paper.
 */
export class SignalQueue {
  private readonly pending: ExamBrowserSignal[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  /** When the window lost focus, or null while it has it. */
  private blurredAt: number | null = null;

  constructor(private readonly deps: SignalQueueDeps) {}

  /** Milliseconds since the window opened. Never negative, never a wall clock. */
  private atMs(): number {
    return Math.max(0, Math.round(this.deps.now() - this.deps.startedAtMs));
  }

  add(signal: ExamBrowserSignal): void {
    this.pending.push(signal);
    // Oldest first: see SIGNAL_QUEUE_MAX.
    while (this.pending.length > SIGNAL_QUEUE_MAX) this.pending.shift();
  }

  /** A kind with no extra facts: fullscreen left, and nothing else to say. */
  note(kind: ExamBrowserSignalKind): void {
    this.add({ kind, atMs: this.atMs() });
  }

  /** How many displays this machine has now. A count and nothing else. */
  displays(count: number): void {
    this.add({ kind: "MULTI_MONITOR", atMs: this.atMs(), displays: count });
  }

  /** The window lost the focus. Nothing is recorded about what took it. */
  focusLost(): void {
    if (this.blurredAt === null) this.blurredAt = this.deps.now();
  }

  /**
   * The window has the focus again. The signal is written now rather than
   * at `blur`, because the useful fact is how long the candidate was away
   * and that is not known until they are back.
   */
  focusRestored(): void {
    const away = this.blurredAt;
    this.blurredAt = null;
    if (away === null) return;
    const durationMs = Math.max(0, Math.round(this.deps.now() - away));
    if (durationMs < FOCUS_NOISE_MS) return;
    this.add({
      kind: "FOCUS_LOSS",
      // Stamped where the window went away, not where it came back.
      atMs: Math.max(0, Math.round(away - this.deps.startedAtMs)),
      durationMs,
    });
  }

  /**
   * A sitting that ends while the window is away still carries the fact
   * that it was away, with the time known so far.
   */
  closeOpenFocusLoss(): void {
    if (this.blurredAt !== null) this.focusRestored();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), SIGNAL_FLUSH_INTERVAL_MS);
    // Never hold the process open for a flush: a sitting that has ended
    // should end.
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** For the fence and for tests: what has not been delivered yet. */
  get queued(): number {
    return this.pending.length;
  }

  async flush(): Promise<void> {
    if (this.flushing || this.pending.length === 0) return;
    const origin = this.deps.origin();
    if (!origin) return;

    this.flushing = true;
    const batch = this.pending.splice(0, EXAM_BROWSER_SIGNAL_BATCH_MAX);
    try {
      const ok = await this.deps.sink.post(`${origin}${EXAM_BROWSER_SIGNALS_PATH}`, JSON.stringify({ signals: batch }));
      // Back to the FRONT, so order survives a failure.
      if (!ok) this.pending.unshift(...batch);
    } catch (error) {
      this.pending.unshift(...batch);
      // The name of the failure, never a URL and never a body.
      this.deps.onError?.(error instanceof Error ? error.name : "unknown");
    } finally {
      while (this.pending.length > SIGNAL_QUEUE_MAX) this.pending.shift();
      this.flushing = false;
    }
  }
}
