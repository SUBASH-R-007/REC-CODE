import { defineConfig } from "tsup";

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
});
