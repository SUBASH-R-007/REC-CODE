import { defineConfig } from "vitest/config";

// Unit tests: pure logic plus fakes. Run on Windows and Linux alike.
// The real-isolate tests live in test/integration (vitest.integration.config.ts).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/integration/**", "**/node_modules/**"],
    environment: "node",
    testTimeout: 30_000,
  },
});
