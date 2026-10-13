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

export default defineConfig({
  // Next compiles with the automatic JSX runtime; match it so component
  // render tests need no global React.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    // With projects, each project names its own files: a root `include` would
    // be concatenated into both of them (extends: true merges arrays).
    ...(RUN_DB_TESTS
      ? {
          projects: [
            {
              extends: true,
              test: { name: "unit", include: INCLUDE, exclude: [...configDefaults.exclude, ...DB_TEST_FILES] },
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
      : { include: INCLUDE }),
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
