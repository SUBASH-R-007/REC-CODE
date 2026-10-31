import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // DB-backed files (RECX_DB_TESTS=1) share one test database: never run
    // them in parallel.
    fileParallelism: false,
    testTimeout: 30_000,
    // beforeAll applies migrations to recx_test with `prisma migrate deploy`.
    hookTimeout: 180_000,
  },
});
