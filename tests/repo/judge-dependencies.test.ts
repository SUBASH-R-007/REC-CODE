import { describe, expect, it } from "vitest";
import { readRepoFile } from "./support/repo";

/**
 * The judge worker's dependency surface (Phase 10f).
 *
 * SPEC §10: the judge stays under twenty direct dependencies. It has been
 * true since Phase 2 — six today — and until now it has never been
 * asserted, which is what taking stock at the end of a phase is for: a
 * number that is true by accident becomes false without anybody noticing.
 *
 * The reason the number matters on THIS process and not on the web app: the
 * worker runs a stranger's code on a host with a setuid sandbox, and every
 * direct dependency is a package that gets to run before the sandbox does.
 * A supply-chain compromise in the web app is a serious incident; one in the
 * judge worker is arbitrary code on the machine whose whole job is to
 * contain arbitrary code.
 */

const LIMIT = 20;

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const worker = JSON.parse(readRepoFile("apps/judge-worker/package.json")) as PackageJson;
const runtime = Object.keys(worker.dependencies ?? {});

describe("the judge worker's direct dependencies", () => {
  it(`stay under ${LIMIT}`, () => {
    expect(runtime.length, `${runtime.length} direct dependencies: ${runtime.join(", ")}`).toBeLessThan(LIMIT);
  });

  it("are the ones the phase took stock of, and each is there for a reason", () => {
    /**
     * A closed list rather than only a count, because the count is the
     * cheap half. Adding a dependency to this process is a decision about
     * what runs on a judge host, and it should be made once, in writing.
     *
     *   @prometheus-io/client  the metrics registry (Phase 10a; prom-client
     *                          renamed, same API)
     *   @recx/shared           this repository's own protocol, limits and
     *                          language catalogue — the thing that keeps the
     *                          worker and the app agreeing
     *   bullmq                 the queue the app dispatches through
     *   ioredis                bullmq's transport, used directly for the
     *                          progress channels
     *   pino                   structured logs
     *   zod                    the job payload and the environment, parsed
     *                          rather than trusted
     */
    expect(runtime.sort()).toEqual(["@prometheus-io/client", "@recx/shared", "bullmq", "ioredis", "pino", "zod"]);
  });

  it("include no database client, and nothing that could turn networking on", () => {
    /**
     * The worker has no database URL and no storage key (its own
     * `test/config.test.ts` fails if a key matching /DATABASE|NET/i is ever
     * added to the environment). This is the same rule one level up: a
     * Prisma client or an HTTP server in here would be the first step
     * towards a worker that reads a problem it has not claimed.
     */
    const forbidden = [/prisma/i, /^pg$/, /mysql/i, /mongo/i, /^express$/, /^fastify$/, /^koa$/, /^axios$/, /puppeteer/i];
    for (const name of runtime) {
      for (const pattern of forbidden) {
        expect(pattern.test(name), `${name} has no business on a judge host`).toBe(false);
      }
    }
  });

  it("keeps the test toolchain out of the runtime list", () => {
    // vitest, tsx, tsup and typescript are devDependencies: a judge host
    // installs `--prod` and gets none of them.
    const dev = Object.keys(worker.devDependencies ?? {});
    for (const tool of ["vitest", "tsx", "tsup", "typescript"]) {
      expect(dev, `${tool} should be a devDependency`).toContain(tool);
      expect(runtime, `${tool} must not be a runtime dependency`).not.toContain(tool);
    }
  });
});

describe("the limit is recorded where somebody will read it", () => {
  it("docs/SECURITY.md says the judge's dependency surface is bounded", () => {
    const security = readRepoFile("docs/SECURITY.md");
    expect(security).toMatch(/judge/i);
    expect(security, "the twenty-dependency limit is a security property, so it belongs in SECURITY.md").toMatch(
      /twenty direct dependencies|under twenty|20 direct dependencies/i,
    );
  });
});
