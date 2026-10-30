import { describe, expect, it } from "vitest";
import { CODE_EXTENSIONS, findFiles, isTestPath, lexSource, readRepoFile } from "./support/repo";

/**
 * The recommender's two promises (Phase 12f).
 *
 * SPEC §11: "the rule-based, explainable recommender (no ML — it has
 * neither the data nor an evaluation harness to beat a good rule, and it
 * cannot explain itself; always render the reason inline …)".
 *
 *   1. **No ML, and nothing that could become it.** The spec's reasoning
 *      is not squeamishness: a model here would have no evaluation harness
 *      to beat a good rule with, and it could not explain itself on a page
 *      whose whole requirement is an explanation. So the fence is on the
 *      dependency list, where a model would have to arrive first.
 *
 *   2. **The reason comes from the rule.** `recommend()` returns the
 *      sentence with the pick, and the card renders that string. A second
 *      place that assembled an explanation would be a place it could
 *      disagree with the decision — which is worse than no explanation,
 *      because a student would believe it.
 */

const ENGINE = "packages/shared/src/recommend.ts";
const CARD = "apps/web/src/components/dashboard/continue-card.tsx";

/** Packages whose presence would mean a model had arrived. */
const ML_PACKAGES = [
  "@tensorflow/tfjs",
  "@tensorflow/tfjs-node",
  "onnxruntime-node",
  "onnxruntime-web",
  "brain.js",
  "ml-matrix",
  "ml-regression",
  "natural",
  "@xenova/transformers",
  "openai",
  "langchain",
  "@langchain/core",
];

describe("no ML, and nothing that could become it", () => {
  it("no workspace package depends on a model runtime or an inference library", () => {
    const manifests = findFiles({ under: ["apps", "packages"], extensions: [".json"] }).filter((file) =>
      file.endsWith("package.json"),
    );
    expect(manifests.length).toBeGreaterThan(3);
    const found: string[] = [];
    for (const file of manifests) {
      const json = JSON.parse(readRepoFile(file)) as Record<string, Record<string, string> | undefined>;
      for (const kind of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
        for (const name of Object.keys(json[kind] ?? {})) {
          if (ML_PACKAGES.includes(name)) found.push(`${file}: ${kind}.${name}`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it("the engine is pure: no database, no clock, no network", () => {
    const source = readRepoFile(ENGINE);
    // A rule engine that read the clock or the database could not be
    // tested by passing it a situation, which is the only way the seven
    // rungs and the rotation get covered at all.
    for (const name of ["server-only", "@/lib/db", "fetch(", "Date.now(", "new Date("]) {
      expect(source, `the engine must not use ${name}`).not.toContain(name);
    }
  });
});

describe("the reason comes from the rule", () => {
  const files = findFiles({ under: ["apps/web/src"], extensions: [...CODE_EXTENSIONS], exclude: isTestPath });

  it("recommend() is called from exactly one place", () => {
    const callers = files.filter((file) => /\brecommend\s*\(/.test(lexSource(readRepoFile(file)).code));
    expect(callers).toEqual(["apps/web/src/server/queries/dashboard.ts"]);
  });

  it("the card renders the reason it was given and writes no sentence of its own", () => {
    const { code } = lexSource(readRepoFile(CARD));
    expect(code).toContain("{reason}");
    // The four rungs that predate Phase 12f had their copy here, in a
    // switch on the action kind. It moved into the engine, and a `case
    // "..."` coming back would mean it had moved out again.
    expect(code).not.toContain("switch (");
    expect(code).not.toMatch(/case "(attempted|plan|daily|suggested)"/);
  });

  it("every rule the engine can return has copy, so none can render blank", () => {
    const engine = readRepoFile(ENGINE);
    const listed = /export const RECOMMENDER_RULES = \[([^\]]+)\]/.exec(engine);
    expect(listed).not.toBeNull();
    const rules = [...listed![1]!.matchAll(/"(\w+)"/g)].map((m) => m[1]!);
    expect(rules.length).toBeGreaterThanOrEqual(7);
    for (const rule of rules) {
      // Returned by a branch, and labelled in both maps.
      expect(engine, `${rule} is returned`).toContain(`rule: "${rule}"`);
      expect(engine, `${rule} has an eyebrow and a CTA`).toContain(`${rule}:`);
    }
  });
});
