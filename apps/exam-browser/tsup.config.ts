import { defineConfig } from "tsup";

/**
 * The build channel, baked in (Phase 14k).
 *
 * `__RECX_BUILD__` is ALWAYS defined, even for a release -- an identifier
 * left undefined in the bundle would be a ReferenceError on the first line
 * of `allowedOrigins`. The default with no environment at all is a release
 * with no extra origins, so the only way to produce a development build is
 * to ask for one: `pnpm --filter @recx/exam-browser release:dev`, which is
 * the script that sets these.
 *
 * `tests/repo/exam-browser-posture.test.ts` reads this file and checks that
 * default, because it is the one line standing between "we built it on a
 * laptop" and an installer that trusts a laptop.
 */
const channel = process.env.RECX_EXAM_BUILD_CHANNEL === "development" ? "development" : "release";
const origins =
  channel === "development"
    ? (process.env.RECX_EXAM_DEV_ORIGIN ?? "http://localhost:3000")
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin !== "")
    : [];

// Two entry points, because Electron loads them in different worlds: the
// main process, and the preload that runs in the renderer's isolated
// context. @recx/shared is workspace TypeScript, so it is bundled in;
// `electron` is provided by the runtime and must stay external.
export default defineConfig({
  entry: ["src/main.ts", "src/preload.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  external: ["electron"],
  noExternal: [/^@recx\//],
  outDir: "dist",
  clean: true,
  sourcemap: true,
  define: {
    __RECX_BUILD__: JSON.stringify({ channel, origins }),
  },
});
