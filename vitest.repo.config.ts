import { defineConfig } from "vitest/config";

// Repository-wide structural tests (tests/repo/*.test.ts): single-source
// definitions, judge isolation, forbidden words, forbidden query shapes —
// plus the load-test harness's own unit tests (scripts/load).
export default defineConfig({
  test: {
    include: ["tests/repo/**/*.test.ts", "scripts/load/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
  },
});
