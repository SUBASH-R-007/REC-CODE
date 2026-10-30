/**
 * Reported in every heartbeat. Kept equal to package.json "version" by
 * test/version.test.ts (a constant, so the bundled dist/main.js needs no
 * package.json lookup at runtime).
 */
export const SQL_JUDGE_VERSION = "0.1.0";

/**
 * The engine version the fleet stores, from `current_setting('server_version')`.
 *
 * A distribution package reports its own build in that setting — "17.11
 * (Ubuntu 17.11-1.pgdg24.04+2)" — and the fleet page shows this string
 * beside a node's id, where the packaging suffix is noise that pushes the
 * number itself off a narrow screen. The number is what a verdict depends
 * on, so the number is what is kept.
 */
export function engineVersionOf(serverVersion: string | undefined): string {
  const version = (serverVersion ?? "").trim().split(/\s+/)[0];
  return `PostgreSQL ${version && version.length > 0 ? version : "unknown"}`;
}
