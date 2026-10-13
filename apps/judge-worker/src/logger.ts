import { pino, type Logger } from "pino";

export type { Logger };

/**
 * Structured JSON logs (journald on judge hosts). Logs carry job kind/id,
 * verdicts and timings — never source code, test data, stdout or the node
 * token.
 */
export function createLogger(options: { level: string; nodeId: string }): Logger {
  return pino({
    name: "judge-worker",
    level: options.level,
    base: { node: options.nodeId },
    redact: { paths: ["token", "*.token", "headers.authorization", "*.headers.authorization"], censor: "[redacted]" },
  });
}

/** A logger that discards everything (tests). */
export function silentLogger(): Logger {
  return pino({ level: "silent" });
}
