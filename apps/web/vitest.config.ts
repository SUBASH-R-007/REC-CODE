import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

const INCLUDE = ["test/**/*.test.ts", "src/**/*.test.ts"];

/**
 * The test files that use the database when RECX_DB_TESTS=1: every
 * *.db.test.ts, plus judge-routes.test.ts (its route tests run against
 * recx_test too). They share one database, so with RECX_DB_TESTS=1 they
 * run one file at a time in a single fork (the "db" project): a teardown
 * that lifts a guard trigger with ALTER TABLE takes an exclusive lock on
 * the table, and two files doing that while the other one writes
 * deadlocked. Every other file stays in the parallel "unit" project, which
 * runs first. Without RECX_DB_TESTS the database files skip, so the plain
 * single-project run keeps them in parallel with everything else.
 */
const DB_TEST_FILES = ["test/**/*.db.test.ts", "test/judge-routes.test.ts"];
const RUN_DB_TESTS = process.env.RECX_DB_TESTS === "1";

/**
 * Processes, not worker threads (Phase 16e).
 *
 * On 2026-11-10 both gates began exiting 1 with every test passing:
 *
 *     Error: [vitest-worker]: Timeout calling "onTaskUpdate"
 *
 * That is a worker failing to deliver a progress update to the reporter
 * inside its RPC timeout — not an assertion, not a product defect, and not
 * one file's fault. This suite contains deliberately CPU-heavy work: the
 * `seed-content` mirrors run every authored problem's reference solution
 * against an independent JS implementation, seconds at a time, synchronously
 * and on purpose. A worker THREAD doing that starves the channel it reports
 * on; a forked process does not.
 *
 * Measured, four ways, before changing anything: the error survived removing
 * the newest test files, removing the changed components, and halving the
 * worker count, and it reproduced on the committed tree with the working
 * copy stashed (`git stash -u`) — on code that had gated green that morning.
 * `--pool=forks` is the only thing that cleared it, at the same wall clock
 * (85 s against 88 s).
 *
 * Nothing about what is asserted changes. Files are still isolated and still
 * run in parallel; only the isolation mechanism differs.
 */
const UNIT_POOL = { pool: "forks" } as const;

export default defineConfig({
  // Next compiles with the automatic JSX runtime; match it so component
  // render tests need no global React.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    /**
     * 20s, not vitest' 5s default.
     *
     * Several suites here exercise the REAL guards and the real server
     * modules, so a single test can load a large module graph and run genuine
     * compute (the capability matrix calls every route handler as every role;
     * seed-content runs an independent implementation over every generated
     * test of every authored problem). Those pass comfortably on their own
     * and time out inside a full `pnpm test`, where the other packages'
     * suites are competing for the same cores — a gate flake that says
     * nothing about the code, and the worst kind, because it moves around.
     *
     * 20s is far above the slowest honest test here (~5s) and far below a
     * hang, so a genuinely stuck test still fails rather than waiting out the
     * gate. Seen 2026-10-19 on `seed-content`, `capability-matrix` and
     * `impersonation-read-only`, each in a different run.
     */
    testTimeout: 20_000,
    // With projects, each project names its own files: a root `include` would
    // be concatenated into both of them (extends: true merges arrays).
    ...(RUN_DB_TESTS
      ? {
          projects: [
            {
              extends: true,
              test: {
                name: "unit",
                include: INCLUDE,
                exclude: [...configDefaults.exclude, ...DB_TEST_FILES],
                ...UNIT_POOL,
              },
            },
            {
              extends: true,
              test: {
                name: "db",
                include: DB_TEST_FILES,
                // One fork runs these files one after another (modules are
                // still reset between files).
                pool: "forks",
                poolOptions: { forks: { singleFork: true } },
              },
            },
          ],
        }
      : { include: INCLUDE, ...UNIT_POOL }),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // `server-only` throws outside the react-server condition; tests run
      // server modules directly.
      "server-only": path.resolve(__dirname, "test/support/server-only.ts"),
    },
  },
});
