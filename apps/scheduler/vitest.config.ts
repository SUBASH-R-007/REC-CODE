import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // The database-backed reconciler test (RECX_DB_TESTS=1) seeds and ticks
    // against recx_test; give it room on a cold Prisma engine.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
