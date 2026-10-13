import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * cloneVersionAsDraft against a real Postgres (recx_test, migrations
 * applied): the hints and the editorial of a FROZEN version are copied into
 * the new DRAFT revision past the frozen-child triggers, the copies are
 * editable while the originals stay immutable, and topic tags stay on the
 * Problem.
 *
 * Opt-in: RECX_DB_TESTS=1 (RECX_TEST_DATABASE_URL overrides the URL; it must
 * name a *_test database). The test-data store and the queue are in-memory
 * fakes; audit() is a spy so the audit chain of the test database is untouched.
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";
const TEST_URL = process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@localhost:5433/recx_test";

const fakes = vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@localhost:5433/recx_test";
  }
  const objects = new Map<string, Buffer>();
  return {
    store: {
      driver: "local" as const,
      async put(key: string, bytes: Buffer) {
        objects.set(key, bytes);
      },
      async get(key: string) {
        const bytes = objects.get(key);
        if (!bytes) throw new Error(`missing ${key}`);
        return bytes;
      },
      async exists(key: string) {
        return objects.has(key);
      },
      async stream(key: string): Promise<ReadableStream<Uint8Array>> {
        return new Blob([new Uint8Array(objects.get(key) ?? Buffer.alloc(0))]).stream();
      },
    },
  };
});

vi.mock("@/lib/judge/queue", () => ({ enqueueJudge: async () => true }));
vi.mock("@/lib/testdata/store", () => ({ getTestDataStore: () => fakes.store }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

type Modules = {
  db: (typeof import("@/lib/db"))["db"];
  validation: typeof import("@/lib/judge/validation");
  blobs: typeof import("@/lib/testdata/blobs");
};

describe.skipIf(!ENABLED)("cloneVersionAsDraft against recx_test", () => {
  const tag = `clone-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let m: Modules;
  let problemId = "";
  let liveId = "";
  const blobShas: string[] = [];
  const HINTS = ["A nudge.", "The key idea.", "Nearly the whole solution."];
  const EDITORIAL = "### Approach\n\nOne pass.\n\n### Complexity\n\nO(n).";

  beforeAll(async () => {
    if (!new URL(TEST_URL).pathname.endsWith("_test")) {
      throw new Error(`Refusing to run against a non-test database: ${new URL(TEST_URL).pathname}`);
    }
    const [dbModule, validation, blobs] = await Promise.all([
      import("@/lib/db"),
      import("@/lib/judge/validation"),
      import("@/lib/testdata/blobs"),
    ]);
    m = { db: dbModule.db, validation, blobs };

    const input = await m.blobs.ensureTestBlob(m.db, fakes.store, Buffer.from(`${tag} input\n`, "utf8"));
    const output = await m.blobs.ensureTestBlob(m.db, fakes.store, Buffer.from(`${tag} output\n`, "utf8"));
    blobShas.push(input.sha256, output.sha256);

    const problem = await m.db.problem.create({
      data: { slug: tag, displayCode: tag.toUpperCase(), title: "Clone Fixture", difficulty: "EASY" },
      select: { id: true },
    });
    problemId = problem.id;
    await m.db.problemTag.createMany({
      data: [
        { problemId, topic: "ARRAYS_HASHING" },
        { problemId, topic: "STRINGS" },
      ],
    });
    const version = await m.db.problemVersion.create({
      data: {
        problemId,
        revision: 1,
        title: "Clone Fixture",
        difficulty: "EASY",
        statementMd: "Fixture.",
        ioMode: "STDIN",
        timeLimitMs: 1000,
      },
      select: { id: true },
    });
    liveId = version.id;
    await m.db.testCase.create({
      data: { problemVersionId: liveId, index: 0, isSample: true, inputSha256: input.sha256, outputSha256: output.sha256 },
    });
    await m.db.hint.createMany({ data: HINTS.map((contentMd, i) => ({ problemVersionId: liveId, tier: i + 1, contentMd })) });
    await m.db.editorial.create({ data: { problemVersionId: liveId, contentMd: EDITORIAL } });
    // Publish: freezing is the one permitted write to the version.
    const now = new Date();
    await m.db.problemVersion.update({ where: { id: liveId }, data: { status: "PUBLISHED", frozenAt: now, publishedAt: now } });
    await m.db.problem.update({ where: { id: problemId }, data: { liveVersionId: liveId, status: "PUBLISHED" } });
  }, 60_000);

  afterAll(async () => {
    if (!m) return;
    try {
      const scope = `SELECT "id" FROM "ProblemVersion" WHERE "problemId" = $1`;
      const guarded = ["Hint", "Editorial", "TestCase", "StarterCode", "ReferenceSolution", "Subtask", "ProblemLanguageLimit", "ProblemVersion"];
      if (problemId) {
        await m.db.$transaction([
          // Published versions are immutable by trigger; teardown lifts the
          // triggers inside this one transaction (no other session sees it).
          ...guarded.map((t) => m.db.$executeRawUnsafe(`ALTER TABLE "${t}" DISABLE TRIGGER "${t}_frozen_guard"`)),
          ...["Hint", "Editorial", "TestCase", "StarterCode", "ReferenceSolution", "Subtask", "ProblemLanguageLimit"].map((t) =>
            m.db.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "problemVersionId" IN (${scope})`, problemId),
          ),
          m.db.$executeRawUnsafe(`UPDATE "Problem" SET "liveVersionId" = NULL WHERE "id" = $1`, problemId),
          m.db.$executeRawUnsafe(`DELETE FROM "ProblemVersion" WHERE "problemId" = $1`, problemId),
          m.db.$executeRawUnsafe(`DELETE FROM "Problem" WHERE "id" = $1`, problemId),
          ...guarded.map((t) => m.db.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE TRIGGER "${t}_frozen_guard"`)),
        ]);
      }
      await m.db.testBlob.deleteMany({ where: { sha256: { in: blobShas } } });
    } finally {
      await m.db.$disconnect();
    }
  }, 60_000);

  it("refuses to add help to the frozen version", async () => {
    await expect(m.db.hint.update({ where: { problemVersionId_tier: { problemVersionId: liveId, tier: 1 } }, data: { contentMd: "changed" } })).rejects.toThrow(
      /frozen/i,
    );
    await expect(m.db.editorial.deleteMany({ where: { problemVersionId: liveId } })).rejects.toThrow(/frozen/i);
    // The database trigger refuses too, even without the repository guard.
    await expect(
      m.db.$executeRawUnsafe(`UPDATE "Hint" SET "contentMd" = 'changed' WHERE "problemVersionId" = $1`, liveId),
    ).rejects.toThrow(/immutable/i);
  });

  it("copies the hints and the editorial into an editable draft revision", async () => {
    const clone = await m.validation.cloneVersionAsDraft(liveId, { createdById: null, via: "test" });
    expect(clone.revision).toBe(2);

    const draft = await m.db.problemVersion.findUniqueOrThrow({
      where: { id: clone.versionId },
      include: { hints: { orderBy: { tier: "asc" } }, editorial: true, testCases: true },
    });
    expect(draft).toMatchObject({ problemId, status: "DRAFT", frozenAt: null });
    expect(draft.hints.map((h) => [h.tier, h.contentMd])).toEqual(HINTS.map((c, i) => [i + 1, c]));
    expect(draft.editorial?.contentMd).toBe(EDITORIAL);
    expect(draft.testCases.map((t) => t.inputSha256)).toEqual([blobShas[0]]);

    // New rows, not shared ones: the draft's help is editable, the original's is not.
    const original = await m.db.hint.findMany({ where: { problemVersionId: liveId }, orderBy: { tier: "asc" } });
    expect(original.map((h) => h.contentMd)).toEqual(HINTS);
    expect(new Set([...original, ...draft.hints].map((h) => h.id)).size).toBe(6);
    await m.db.hint.update({
      where: { problemVersionId_tier: { problemVersionId: clone.versionId, tier: 3 } },
      data: { contentMd: "A clearer near-solution." },
    });
    expect((await m.db.hint.findMany({ where: { problemVersionId: liveId }, orderBy: { tier: "asc" } })).map((h) => h.contentMd)).toEqual(HINTS);

    // Topic tags stay on the Problem: no copy, no change.
    const tags = await m.db.problemTag.findMany({ where: { problemId }, orderBy: { topic: "asc" } });
    expect(tags.map((t) => t.topic)).toEqual(["ARRAYS_HASHING", "STRINGS"]);
  });
});
