/**
 * Reported in every heartbeat. Kept equal to package.json "version" by
 * test/version.test.ts (a constant, so the bundled dist/main.js needs no
 * package.json lookup at runtime).
 */
export const WORKER_VERSION = "0.1.0";
