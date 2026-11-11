import { defineConfig } from "vitest/config";

// Unit tests only, and that is a design constraint rather than a shortcut:
// every decision this application makes lives in a pure module that takes
// plain values, so the rules can be tested on any machine without starting
// Electron. `src/main.ts` is wiring, and wiring is what the repo fences
// read instead (tests/repo/exam-browser-posture.test.ts).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
    environment: "node",
  },
});
