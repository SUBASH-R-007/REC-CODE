import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "node",
    // The palette property test derives 1,080 themes.
    testTimeout: 60_000,
  },
});
