import { defineConfig } from "tsup";

/**
 * One ESM bundle for `node dist/main.js`. The workspace packages (@recx/*)
 * ship TypeScript source, so they are bundled in; @prisma/client stays
 * external because it loads the generated client and its native query engine
 * from node_modules at runtime. Every other dependency resolves from
 * node_modules as usual.
 */
export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  noExternal: [/^@recx\//],
  external: ["@prisma/client"],
});
