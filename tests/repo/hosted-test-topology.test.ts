import { describe, expect, it } from "vitest";
import { readRepoFile } from "./support/repo";

/**
 * The temporary hosted test deployment: Vercel for the web app, Render for
 * Postgres, Redis and the scheduler (`docs/DEPLOY-HOSTED-TEST.md`,
 * `apps/web/vercel.json`, `render.yaml`).
 *
 * It is a throwaway, which is exactly why it is fenced. A throwaway
 * deployment is where a credential gets committed "just for now", and it is
 * where somebody discovers by accident that a managed platform cannot run
 * the judge — a thing this repository should state rather than let a student
 * find out from a submission that never gets a verdict.
 *
 * NOT RUN HERE: nothing below has been applied. These are assertions about
 * files, which is all a static check can be, and the names are the whole
 * interface (the same reasoning as the compose fence in
 * deploy-topology.test.ts).
 */

const VERCEL = "apps/web/vercel.json";
const RENDER = "render.yaml";
const DOC = "docs/DEPLOY-HOSTED-TEST.md";

interface VercelConfig {
  framework?: string;
  buildCommand?: string;
  installCommand?: string;
  outputDirectory?: string;
  env?: Record<string, string>;
  build?: { env?: Record<string, string> };
}

describe("the Vercel project", () => {
  const vercel = JSON.parse(readRepoFile(VERCEL)) as VercelConfig;

  it("builds this monorepo's web app with pnpm", () => {
    expect(vercel.framework).toBe("nextjs");
    // The repository is a pnpm workspace; a lockfile-respecting install is
    // the difference between building what CI built and building something
    // else.
    expect(vercel.installCommand).toContain("pnpm install");
    expect(vercel.installCommand).toContain("--frozen-lockfile");
    expect(vercel.buildCommand).toContain("build");
  });

  it("carries no environment values at all", () => {
    /**
     * Vercel takes environment variables in its own dashboard. Anything in
     * this file is in git, and `env`/`build.env` here is how a pepper ends
     * up in a public repository.
     */
    expect(vercel.env, "set environment variables in the Vercel project, never in vercel.json").toBeUndefined();
    expect(vercel.build?.env).toBeUndefined();
  });
});

describe("the Render blueprint", () => {
  const render = readRepoFile(RENDER);
  const doc = readRepoFile(DOC);

  it("says it has not been run here", () => {
    expect(render).toMatch(/NOT RUN HERE/);
  });

  it("creates the database and the queue, and nothing that judges", () => {
    expect(render).toMatch(/^databases:/m);
    expect(render).toMatch(/name: recx-db/);
    expect(render).toMatch(/type: keyvalue/);
    /**
     * No judge worker, and the file has to say why rather than leave its
     * absence to be read as an oversight: isolate needs a setuid binary and
     * cgroup v2 on a host you control, and student code never runs in the
     * web process.
     */
    expect(render).not.toMatch(/judge-worker/);
    expect(render).toMatch(/isolate/);
  });

  it("costs nothing: every plan is a free one", () => {
    const plans = [...render.matchAll(/^\s*plan:\s*(\S+)/gm)].map((m) => m[1]!);
    expect(plans.length, "render.yaml declares no plan at all").toBeGreaterThan(1);
    expect([...new Set(plans)], "a paid plan crept into the free-tier blueprint").toEqual(["free"]);
  });

  it("runs no background worker, because Render has no free one — and says what that costs", () => {
    /**
     * The honest version of a free deployment: Render's free tier covers
     * web services and static sites, not workers, and a free web service
     * sleeps after fifteen minutes without traffic — useless for a process
     * whose whole job is to tick. So the blueprint leaves the scheduler out
     * and the file has to name the hole rather than let somebody discover
     * it when a flagged submission is never released by the 72-hour SLA.
     */
    expect(render).not.toMatch(/type:\s*worker/);
    expect(render).toMatch(/reconciler/);
    expect(render).toMatch(/--once/);
  });

  it("opens the database and the queue to the clients that are all outside Render", () => {
    // Every consumer is external — Vercel's functions, the migrations and
    // seed from a laptop, a judge worker attached from outside. An
    // internal-only allow list would leave the deployment unable to reach
    // its own database, which is a confusing way to spend an evening.
    expect([...render.matchAll(/ipAllowList:/g)].length).toBe(2);
    expect(render).not.toMatch(/ipAllowList:\s*\[\]/);
  });

  it("gives BullMQ a Redis that does not evict", () => {
    // An evicted key is a lost job. The reconciler re-enqueues from
    // Postgres, but a queue that silently drops work is not a queue.
    expect(render).toMatch(/maxmemoryPolicy:\s*noeviction/);
  });

  it("passes no credential as a value", () => {
    /**
     * The same rule as `deploy/` (deploy-topology.test.ts): every value is
     * wired from the database, from the Key Value service, or asked for at
     * apply time. The allowlist is for the handful of settings that are not
     * secrets and would be noise as prompts.
     */
    const PLAIN = new Set(["NODE_VERSION", "NODE_ENV", "MAIL_TRANSPORT"]);
    const lines = render.replace(/\r\n/g, "\n").split("\n");
    const offenders: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const key = /^\s*- key:\s*([A-Z][A-Z0-9_]*)\s*$/.exec(lines[i]!);
      if (!key) continue;
      const name = key[1]!;
      const next = lines[i + 1] ?? "";
      const wired = /\b(fromDatabase|fromService|sync:\s*false|generateValue:\s*true):?/.test(next);
      const literal = /^\s*value:/.test(next);
      if (wired) continue;
      if (literal && PLAIN.has(name)) continue;
      offenders.push(`${name}: ${next.trim()}`);
    }
    expect(offenders, "wire it from a service, or ask for it with `sync: false`").toEqual([]);
  });

  it("tells a tick to use the direct database URL", () => {
    // The scheduler's config refuses a missing DATABASE_URL_DIRECT outside
    // development: advisory locks and SKIP LOCKED leases do not survive a
    // pooler, so the pooled URL is not a substitute.
    expect(doc).toMatch(/DATABASE_URL_DIRECT="<render external url>"/);
  });
});

describe("the hosted-test document", () => {
  const doc = readRepoFile(DOC);

  /** Keys of `const shape = {` in apps/web/src/lib/env.ts, with their definitions. */
  function webSchema(): Map<string, string> {
    const source = readRepoFile("apps/web/src/lib/env.ts");
    const start = source.indexOf("const shape = {");
    const close = /^\}( as const)?;/m.exec(source.slice(start));
    const body = source.slice(start, start + (close?.index ?? 0));
    const entries = new Map<string, string>();
    const boundaries = [...body.matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm)];
    for (let i = 0; i < boundaries.length; i++) {
      const from = boundaries[i]!.index!;
      const to = i + 1 < boundaries.length ? boundaries[i + 1]!.index! : body.length;
      entries.set(boundaries[i]![1]!, body.slice(from, to));
    }
    expect(entries.size).toBeGreaterThan(5);
    return entries;
  }

  it("tells the operator every variable the app will refuse to start without", () => {
    /**
     * The fence that keeps the document true as the schema changes: a
     * variable with no default and no `.optional()` is one the app demands,
     * and a hosted deployment that does not set it fails at the first
     * request with a message nobody is watching for.
     */
    const required = [...webSchema()]
      .filter(([, definition]) => !definition.includes(".default(") && !definition.includes(".optional()"))
      .map(([key]) => key);
    expect(required).toContain("DATABASE_URL");
    for (const key of required) {
      expect(doc, `${DOC} does not mention ${key}, which the app requires`).toContain(key);
    }
  });

  it("tells the operator about the two it would otherwise default in production", () => {
    const env = readRepoFile("apps/web/src/lib/env.ts");
    const list = /const REQUIRED_IN_PRODUCTION = \[([^\]]*)\]/.exec(env);
    expect(list, "apps/web/src/lib/env.ts no longer declares REQUIRED_IN_PRODUCTION").not.toBeNull();
    for (const key of [...list![1]!.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]!)) {
      expect(doc, `${DOC} does not mention ${key}`).toContain(key);
    }
  });

  it("says plainly that nothing there can judge, and what to do instead", () => {
    expect(doc).toMatch(/isolate/);
    expect(doc).toMatch(/QUEUED/);
    // The honest alternative, not a fabricated verdict.
    expect(doc).toMatch(/RECX_DRIVER=mock/);
    expect(doc).toMatch(/refuses to start/);
  });

  it("says the hosted deployment is not the real one, and where the real one is", () => {
    expect(doc).toContain("deploy/compose.app.yml");
    expect(doc).toMatch(/NOT RUN HERE/);
    // A free database that disappears is fine for a week of testing and is
    // the sort of thing that must never be a surprise.
    expect(doc).toMatch(/30 days/);
  });
});
