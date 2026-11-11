import { describe, expect, it } from "vitest";
import { readRepoFile } from "./support/repo";

/**
 * Every development judge engine needs a node registered before the app will
 * accept a heartbeat from it, and there is more than one engine: the isolate
 * worker and the SQL judge. Getting that wrong fails quietly in the worst
 * way — the engine boots, passes its self-check and starts listening, then
 * every heartbeat comes back 401 while a student's submission in that lane
 * sits at DISPATCHED with nothing on screen to say why. Nobody watching the
 * engine's own log would call it broken.
 *
 * The seed is what closes that gap, from variables an operator has to set by
 * hand. So the two halves worth holding together are: every JUDGE_DEV_*_ID /
 * _TOKEN pair the seed reads is a pair `.env.example` tells the operator to
 * set, and every pair `.env.example` offers is one the seed actually reads.
 * Either half alone is a node that never gets registered, or a variable set
 * in good faith that nothing ever looks at.
 */

const SEED = "apps/web/scripts/seed.ts";
const ENV_EXAMPLE = "apps/web/.env.example";
const SQL_SANDBOX = "scripts/dev/sql-sandbox-up.mjs";

/** The prefixes the seed turns into `${which}_ID` / `${which}_TOKEN`. */
function seedPrefixes(): string[] {
  const source = readRepoFile(SEED);
  const block = /const DEV_JUDGE_NODES = \[([\s\S]*?)\] as const;/.exec(source);
  expect(block, `${SEED} should declare DEV_JUDGE_NODES`).not.toBeNull();
  const prefixes = [...block![1]!.matchAll(/which: "([A-Z0-9_]+)"/g)].map((m) => m[1]!);
  expect(prefixes.length, "DEV_JUDGE_NODES should name at least one engine").toBeGreaterThan(0);
  return prefixes;
}

/** The prefixes `.env.example` offers, from its JUDGE_DEV_*_TOKEN lines. */
function documentedPrefixes(): string[] {
  const source = readRepoFile(ENV_EXAMPLE);
  return [...source.matchAll(/^(JUDGE_DEV[A-Z0-9_]*)_TOKEN=/gm)].map((m) => m[1]!);
}

describe("the development judge nodes", () => {
  it("reads only variable pairs that .env.example tells the operator to set", () => {
    const documented = documentedPrefixes();
    for (const prefix of seedPrefixes()) {
      expect(documented, `${ENV_EXAMPLE} should offer ${prefix}_ID / ${prefix}_TOKEN`).toContain(prefix);
    }
  });

  it("reads every variable pair .env.example offers", () => {
    const read = seedPrefixes();
    for (const prefix of documentedPrefixes()) {
      expect(read, `${SEED} should register a node from ${prefix}_ID / ${prefix}_TOKEN`).toContain(prefix);
    }
  });

  it("offers an id and a token for each pair, the id defaulted and the token blank", () => {
    const source = readRepoFile(ENV_EXAMPLE);
    for (const prefix of documentedPrefixes()) {
      // A token in the example file would be a token in git; the id is only a
      // name, so defaulting it saves the operator a decision.
      expect(source, `${prefix}_TOKEN must be blank in ${ENV_EXAMPLE}`).toContain(`${prefix}_TOKEN=""`);
      expect(source, `${ENV_EXAMPLE} should default ${prefix}_ID`).toMatch(
        new RegExp(`^${prefix}_ID="[A-Za-z0-9._-]+"$`, "m"),
      );
    }
  });

  it("registers the node the SQL judge itself is configured to be", () => {
    // The two files are written by different hands at different times: the
    // sandbox script generates the judge's credentials, an operator copies
    // them across. They can only meet if both default to the same node id.
    const sandbox = readRepoFile(SQL_SANDBOX);
    const fallback = /RECX_NODE_ID=\$\{existing\.RECX_NODE_ID \?\? "([A-Za-z0-9._-]+)"\}/.exec(sandbox);
    expect(fallback, `${SQL_SANDBOX} should default RECX_NODE_ID`).not.toBeNull();
    expect(readRepoFile(ENV_EXAMPLE)).toContain(`JUDGE_DEV_SQL_NODE_ID="${fallback![1]!}"`);
  });

  it("tells the operator, where the SQL credentials are made, that registering is a second step", () => {
    // The whole failure is that nothing says anything. apps/sql-judge has no
    // .env.example of its own — this script writes its .env.local outright —
    // so this script is the only place the operator is told, and it has to
    // name the app-side variables or the step stays invisible.
    const sandbox = readRepoFile(SQL_SANDBOX);
    expect(sandbox).toContain("JUDGE_DEV_SQL_NODE_ID");
    expect(sandbox).toContain("JUDGE_DEV_SQL_NODE_TOKEN");
  });
});
