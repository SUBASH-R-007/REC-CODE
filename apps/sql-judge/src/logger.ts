import { pino, type Logger } from "pino";

export type { Logger };

/**
 * Structured JSON logs (journald on a judge host). Logs carry job kind/id,
 * verdicts and timings — never a student's query, never the dataset, never
 * the node token and never a connection string.
 */
export function createLogger(options: { level: string; nodeId: string }): Logger {
  return pino({
    name: "sql-judge",
    level: options.level,
    base: { node: options.nodeId },
    redact: {
      paths: [
        "token",
        "*.token",
        "source",
        "*.source",
        "setup",
        "*.setup",
        "headers.authorization",
        "*.headers.authorization",
      ],
      censor: "[redacted]",
    },
  });
}

/** A logger that discards everything (tests). */
export function silentLogger(): Logger {
  return pino({ level: "silent" });
}
