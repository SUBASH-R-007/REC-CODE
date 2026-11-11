/**
 * One valid row per frozen child model (FROZEN_CHILD_MODELS in
 * src/frozen.ts), used by frozen-children.test.ts. frozen-coverage.test.ts
 * asserts the keys equal FROZEN_CHILD_MODELS, so a new version-child model
 * without a factory fails on every platform, not only where the database
 * tests run.
 *
 * Pure data: no Prisma import, so it can be loaded before the test sets its
 * database environment.
 */

export interface FactoryContext {
  /** sha256 of an existing TestBlob used as a test input. */
  inputSha256: string;
  /** sha256 of an existing TestBlob used as a test output. */
  outputSha256: string;
}

export interface ChildFactory {
  /**
   * Scalar create data for row `n` (1–3) under `versionId`. Every NOT NULL
   * column is given explicitly, so the same object also works as a raw
   * `json_populate_record` INSERT.
   */
  create(versionId: string, n: number, ctx: FactoryContext): Record<string, unknown>;
  /** An ordinary content edit for update / updateMany / upsert. */
  edit: Record<string, unknown>;
}

export const FACTORIES: Record<string, ChildFactory> = {
  TestCase: {
    create: (problemVersionId, n, ctx) => ({
      problemVersionId,
      index: n,
      isSample: false,
      inputSha256: ctx.inputSha256,
      outputSha256: ctx.outputSha256,
    }),
    edit: { isSample: true },
  },
  StarterCode: {
    create: (problemVersionId, n) => ({ problemVersionId, language: `lang${n}`, code: `// starter ${n}\n` }),
    edit: { code: "// edited starter\n" },
  },
  ReferenceSolution: {
    create: (problemVersionId, n) => ({
      problemVersionId,
      language: "cpp20",
      label: `Reference ${n}`,
      source: `int main() { return ${n - 1}; }\n`,
      expectedVerdict: "AC",
    }),
    edit: { expectedVerdict: "WA" },
  },
  Subtask: {
    create: (problemVersionId, n) => ({ problemVersionId, index: n, points: 10, aggregation: "MIN", dependsOn: [] }),
    edit: { points: 20 },
  },
  ProblemLanguageLimit: {
    create: (problemVersionId, n) => ({ problemVersionId, language: `lang${n}`, timeLimitMs: 1000, memoryLimitKb: 262144 }),
    edit: { timeLimitMs: 2000 },
  },
  Hint: {
    // Tier is 1–3 (Hint_tier_check) and unique per version.
    create: (problemVersionId, n) => ({ problemVersionId, tier: ((n - 1) % 3) + 1, contentMd: `Hint ${n}` }),
    edit: { contentMd: "Edited hint" },
  },
  Editorial: {
    // One editorial per version (problemVersionId is unique).
    create: (problemVersionId) => ({ problemVersionId, contentMd: "Editorial" }),
    edit: { contentMd: "Edited editorial" },
  },
};
