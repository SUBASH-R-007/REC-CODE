import { defineConfig } from "vitest/config";

/**
 * Unit tests: pure logic plus fakes, on Windows and Linux alike.
 *
 * The tests that need a real PostgreSQL are the `.db.test.ts` files, and
 * they skip themselves unless RECX_SQL_TESTS=1 — the same opt-in shape the
 * database suites elsewhere use, because the whole point of them is that
 * they talk to a cluster.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
    environment: "node",
    testTimeout: 60_000,
  },
});
