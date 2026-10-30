import { defineConfig } from "tsup";

// One self-contained ESM file. @recx/shared is TypeScript source in the
// workspace, so it is bundled in; real npm dependencies stay external and are
// installed next to dist/ on the judge host.
export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  noExternal: [/^@recx\//],
  outDir: "dist",
  clean: true,
  sourcemap: true,
});
