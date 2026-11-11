import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * cloneVersionAsDraft copies every child of a version into the new DRAFT
 * revision — Phase 3 adds the hints and the editorial — and never touches
 * problem-level data such as topic tags. A recording fake client stands in
 * for Postgres (the opt-in validation-clone.db.test.ts runs the real thing).
 */

const fake = vi.hoisted(() => {
  const calls: { model: string; op: string; args: unknown }[] = [];
  const source = {
    id: "v-live",
    problemId: "p-1",
    revision: 3,
    title: "Handle Maker",
    difficulty: "EASY",
    statementMd: "statement",
    constraints: ["1 ≤ n"],
    ioMode: "FUNCTION",
    functionSignature: { className: "Solution" },
    compareMode: "TOKEN",
    floatEpsilon: null,
    scoringMode: "ICPC",
    stopOnFirstFailure: true,
    timeLimitMs: 1000,
    memoryLimitKb: 262_144,
    checkerSha256: null,
    testlibId: null,
    testCases: [{ index: 0, isSample: true, inputSha256: "in0", outputSha256: "out0", points: null, subtaskIndex: null }],
    starterCodes: [{ language: "cpp20", code: "class Solution {};" }],
    referenceSolutions: [{ language: "cpp20", label: "Model", source: "class Solution {};", expectedVerdict: "AC" }],
    subtasks: [],
    hints: [
      { id: "h1", problemVersionId: "v-live", tier: 1, contentMd: "nudge" },
      { id: "h2", problemVersionId: "v-live", tier: 2, contentMd: "key idea" },
      { id: "h3", problemVersionId: "v-live", tier: 3, contentMd: "near-solution" },
    ] as { id: string; problemVersionId: string; tier: number; contentMd: string }[],
    editorial: { id: "e1", problemVersionId: "v-live", contentMd: "### Approach" } as {
      id: string;
      problemVersionId: string;
      contentMd: string;
    } | null,
  };

  /** Any model: every method records its call; a few return what the clone needs. */
  const model = (name: string, returns: Record<string, (args: unknown) => unknown> = {}) =>
    new Proxy(
      {},
      {
        get: (_t, op: string) => async (args: unknown) => {
          calls.push({ model: name, op, args });
          return returns[op]?.(args) ?? { count: 0 };
        },
      },
    );

  const problemVersion = model("problemVersion", {
    findUnique: (args) => {
      const { where } = args as { where: { id: string } };
      if (where.id === "v-live") return source;
      // The clone reads only its source: drafts never write a bundle (publish does, after the freeze).
      throw new Error(`unexpected read of ${where.id}`);
    },
    findFirst: () => ({ revision: 3 }),
    create: () => ({ id: "v-draft" }),
  });
  const client = {
    problemVersion,
    testCase: model("testCase"),
    subtask: model("subtask"),
    starterCode: model("starterCode"),
    referenceSolution: model("referenceSolution"),
    hint: model("hint"),
    editorial: model("editorial"),
    problemTag: model("problemTag"),
    problem: model("problem"),
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),
  };
  return { calls, source, client };
});

vi.mock("@/lib/db", () => ({ db: fake.client }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/judge/queue", () => ({ enqueueJudge: vi.fn() }));
vi.mock("@/lib/testdata/store", () => ({ getTestDataStore: () => ({}) }));

const { cloneVersionAsDraft } = await import("@/lib/judge/validation");
const { audit } = await import("@/lib/audit");

const callsTo = (model: string, op?: string) => fake.calls.filter((c) => c.model === model && (op === undefined || c.op === op));

describe("cloneVersionAsDraft", () => {
  beforeEach(() => {
    fake.calls.length = 0;
    vi.mocked(audit).mockClear();
  });

  it("copies the hints and the editorial into the new draft revision", async () => {
    const created = await cloneVersionAsDraft("v-live", { createdById: "admin", via: "test" });
    expect(created).toEqual({ versionId: "v-draft", revision: 4 });

    const read = callsTo("problemVersion", "findUnique")[0]!.args as { include: Record<string, unknown> };
    expect(read.include).toMatchObject({ hints: expect.anything(), editorial: true });

    expect(callsTo("hint", "createMany").map((c) => c.args)).toEqual([
      {
        data: [
          { problemVersionId: "v-draft", tier: 1, contentMd: "nudge" },
          { problemVersionId: "v-draft", tier: 2, contentMd: "key idea" },
          { problemVersionId: "v-draft", tier: 3, contentMd: "near-solution" },
        ],
      },
    ]);
    expect(callsTo("editorial", "create").map((c) => c.args)).toEqual([
      { data: { problemVersionId: "v-draft", contentMd: "### Approach" } },
    ]);
  });

  it("still copies every other child, writes nothing to the source, and leaves topic tags alone", async () => {
    await cloneVersionAsDraft("v-live", { createdById: "admin", via: "test" });
    expect(callsTo("testCase", "createMany")).toHaveLength(1);
    expect(callsTo("starterCode", "createMany")).toHaveLength(1);
    expect(callsTo("referenceSolution", "createMany")).toHaveLength(1);
    expect(callsTo("problemVersion", "create")[0]!.args).toMatchObject({
      data: { problemId: "p-1", revision: 4, status: "DRAFT", ioMode: "FUNCTION" },
    });
    // Every write targets the new draft; the frozen source is only read.
    const writes = fake.calls.filter((c) => /^(create|update|upsert|delete)/.test(c.op) && c.model !== "problemVersion");
    for (const w of writes) expect(JSON.stringify(w.args)).not.toContain('"v-live"');
    expect(callsTo("problemVersion", "update")).toHaveLength(0);
    // ProblemTag belongs to the Problem: no revision copies or rewrites it.
    expect(callsTo("problemTag")).toHaveLength(0);
    expect(callsTo("problem")).toHaveLength(0);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "problem.revision.created", entityId: "v-draft" }),
    );
  });

  it("copies nothing extra when the source has no hints or editorial", async () => {
    const { hints, editorial } = fake.source;
    fake.source.hints = [];
    fake.source.editorial = null;
    try {
      await cloneVersionAsDraft("v-live", { createdById: null, via: "test" });
      expect(callsTo("hint")).toHaveLength(0);
      expect(callsTo("editorial")).toHaveLength(0);
    } finally {
      fake.source.hints = hints;
      fake.source.editorial = editorial;
    }
  });
});
