import { defineConfig } from "vitest/config";

// Linux-only sandbox integration tests (real isolate, real toolchains).
// Each file skips itself unless RECX_ISOLATE_INTEGRATION=1 on Linux.
// One fork, files in sequence: the tests share isolate box ids.
export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 600_000,
    hookTimeout: 120_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
  },
});
