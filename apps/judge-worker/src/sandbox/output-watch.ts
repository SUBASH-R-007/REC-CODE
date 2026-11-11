import { LIMITS } from "@recx/shared";

/**
 * The supervisor's early output trip. While a program runs, the size of its
 * stdout capture is polled every `pollMs` (LIMITS.earlyOle.pollMs = 200 ms);
 * the first poll that sees more than `limitBytes` calls `onExceeded` once
 * (the sandbox then stops the box: OLE). So a run is stopped within one poll
 * interval plus one stat() of passing the cap — well inside a second — instead
 * of writing until --fsize or the wall clock ends it.
 *
 * Polls never overlap, and a failing size probe is ignored (the next poll
 * retries; --fsize still bounds the file). Returns the function that stops
 * watching.
 */
export interface OutputWatchOptions {
  /** Current size of the capture file, in bytes. */
  size: () => Promise<number>;
  limitBytes: number;
  pollMs?: number;
  onExceeded: () => void;
}

export function watchOutputSize(options: OutputWatchOptions): () => void {
  let polling = false;
  let tripped = false;
  let stopped = false;
  const timer = setInterval(() => {
    if (polling || tripped || stopped) return;
    polling = true;
    options
      .size()
      .then((bytes) => {
        if (!stopped && !tripped && bytes > options.limitBytes) {
          tripped = true;
          options.onExceeded();
        }
      })
      .catch(() => undefined)
      .finally(() => {
        polling = false;
      });
  }, options.pollMs ?? LIMITS.earlyOle.pollMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
