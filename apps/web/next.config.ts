import type { NextConfig } from "next";
import path from "node:path";

const REPO_ROOT = path.join(process.cwd(), "../..");

// The slice of the webpack 5 API that ClientChunkMapPlugin touches.
interface WpModule {
  /** Set on a ConcatenatedModule: the modules it inlines. */
  modules?: Iterable<WpModule>;
  nameForCondition?(): string | null;
  identifier(): string;
  size(): number;
}
interface WpChunk {
  files: Iterable<string>;
}
interface WpCompilation {
  chunks: Iterable<WpChunk>;
  chunkGraph: { getChunkModulesIterable(chunk: WpChunk): Iterable<WpModule> };
  hooks: { processAssets: { tap(options: { name: string; stage: number }, fn: () => void): void } };
  emitAsset(file: string, source: unknown): void;
}
interface WpCompiler {
  webpack: {
    Compilation: { PROCESS_ASSETS_STAGE_REPORT: number };
    sources: { RawSource: new (source: string) => unknown };
  };
  hooks: { thisCompilation: { tap(name: string, fn: (compilation: WpCompilation) => void): void } };
}

/** "…/node_modules/.pnpm/x@1/node_modules/monaco-editor/esm/a.js" → "node_modules/monaco-editor/esm/a.js". */
function moduleName(mod: WpModule): string {
  const raw = (mod.nameForCondition?.() ?? mod.identifier()).split("!").pop() ?? "";
  const rel = path.relative(REPO_ROOT, raw).split(path.sep).join("/");
  const nm = rel.lastIndexOf("node_modules/");
  return nm >= 0 ? rel.slice(nm) : rel;
}

/**
 * Production client builds only: writes .next/recx-client-chunks.json —
 * every emitted JS chunk with the source modules inside it (repo-relative
 * path, pre-minification bytes). scripts/size-budget.mjs reads it to keep
 * Monaco out of routes that must not load it and to tell first-party code
 * from framework code. Nothing in the bundle changes.
 */
class ClientChunkMapPlugin {
  apply(compiler: WpCompiler) {
    const name = "RecxClientChunkMap";
    compiler.hooks.thisCompilation.tap(name, (compilation) => {
      compilation.hooks.processAssets.tap(
        { name, stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_REPORT },
        () => {
          const chunks: Record<string, [string, number][]> = {};
          for (const chunk of compilation.chunks) {
            const modules: [string, number][] = [];
            for (const mod of compilation.chunkGraph.getChunkModulesIterable(chunk)) {
              for (const inner of mod.modules ?? [mod]) modules.push([moduleName(inner), inner.size()]);
            }
            for (const file of chunk.files) if (file.endsWith(".js")) chunks[file] = modules;
          }
          const json = JSON.stringify({ version: 1, chunks });
          compilation.emitAsset("recx-client-chunks.json", new compiler.webpack.sources.RawSource(json));
        },
      );
    });
  }
}

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(process.cwd(), "../.."),
  /**
   * `.next`, unless RECX_DIST_DIR says otherwise. Unset everywhere that
   * matters — the deployment, CI and `pnpm size` all read `.next`.
   *
   * It exists so a second Next server can run beside the first on this
   * laptop without destroying its build, because `next dev` and `next start`
   * otherwise share one directory and the dev server overwrites a production
   * build in place. The case that needs it: showing the production bundle
   * while a judge node is attached. The judge's heartbeat is refused by a
   * production web app (an unhardened WSL2 kernel, `docs/RUNBOOK.md` §1.5),
   * so the node heartbeats to a development server on another port instead,
   * and the production app dispatches to the same Redis and reads the same
   * Postgres. A demo arrangement for one machine, never a deployment.
   */
  distDir: process.env.RECX_DIST_DIR ?? ".next",
  poweredByHeader: false,
  reactStrictMode: true,
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@recx/shared", "@recx/design", "@recx/db"],
  experimental: {
    // Both barrels are pure re-exports: import only the modules a file uses.
    // Without this every client page carried all of @recx/shared (zod and
    // the judge protocol included) and every "use client" design component
    // — see docs/CAPACITY.md, "Front-end budgets".
    optimizePackageImports: ["@recx/design", "@recx/shared"],
  },
  // Native / Node-only modules stay outside the server bundle.
  serverExternalPackages: ["@node-rs/argon2", "bullmq", "ioredis", "pino", "@prisma/client", "yauzl"],
  // `pnpm lint` at the repo root is the lint gate (flat config with the
  // repo's hard rules); don't run a second, differently-configured pass here.
  eslint: { ignoreDuringBuilds: true },
  webpack(config: { plugins: unknown[] }, { dev, isServer }: { dev: boolean; isServer: boolean }) {
    if (!dev && !isServer) config.plugins.push(new ClientChunkMapPlugin());
    return config;
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), display-capture=()" },
        ],
      },
      {
        // Self-hosted Monaco: immutable per monaco-editor version.
        source: "/monaco/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
    ];
  },
};

export default nextConfig;
