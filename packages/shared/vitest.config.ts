import { defineConfig } from "vitest/config";

// Pure unit tests: no I/O, no database, no network.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
