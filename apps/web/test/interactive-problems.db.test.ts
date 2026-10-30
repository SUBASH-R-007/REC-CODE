import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Interactive problems in the data model (Phase 12l, slice 2), against a
 * real PostgreSQL.
 *
 * Three things need a database here. The four CHECKs, which say what an
 * interactive version IS and refuse every half of one. The ASSESSMENT
 * rule, which is a trigger because the fact lives on another table and
 * which exists because SPEC §11 says to keep these out of high-stakes
 * sittings until two practice contests have gone cleanly. And the
 * authoring edit itself: attaching an interactor is a change to how the
 * problem is judged, so it must move `judgeSeq` and invalidate the
 * validation runs that came before it.
 *
 * Opt-in: RECX_DB_TESTS=1.
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";

vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";
  }
});

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));
vi.mock("@/lib/redis", () => ({
  redis: () => ({ publish: async () => 1 }),
  newSubscriber: () => {
    throw new Error("no subscribers here");
  },
}));

const objects = vi.hoisted(() => new Map<string, Buffer>());
vi.mock("@/lib/testdata/store", () => ({
  getTestDataStore: () => ({
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
  }),
}));

const INTERACTOR = `#include "testlib.h"
int main(int argc, char* argv[]) { registerInteraction(argc, argv); return 0; }
`;
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

describe.skipIf(!ENABLED)("interactive problems against recx_test", () => {
  const tag = `inter-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let db: import("@recx/db").Db;
  let edits: typeof import("@/lib/authoring/edits");
  let problemId = "";
  let actorId = "";
  const blobShas: string[] = [];

  async function blob(text: string) {
    const digest = sha(text);
    await db.testBlob.upsert({
      where: { sha256: digest },
      create: { sha256: digest, sizeBytes: Buffer.byteLength(text, "utf8"), inline: text },
      update: {},
    });
    blobShas.push(digest);
    return digest;
  }

  /** An interactive version, frozen or not, with whatever overrides a case needs. */
  async function version(over: Record<string, unknown> = {}) {
    return db.problemVersion.create({
      data: {
        problemId,
        revision: Math.floor(Math.random() * 1_000_000),
        status: "DRAFT",
        title: "Guess the number",
        difficulty: "EASY",
        statementMd: "Guess it in 40 queries.",
        ioMode: "STDIN",
        compareMode: "INTERACTIVE",
        scoringMode: "ICPC",
        stopOnFirstFailure: true,
        timeLimitMs: 2000,
        ...over,
      } as never,
      select: { id: true, editSeq: true, judgeSeq: true },
    });
  }

  beforeAll(async () => {
    const { createPrismaClient } = await import("@recx/db");
    db = createPrismaClient({
      url: process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test",
      log: [],
    });
    edits = await import("@/lib/authoring/edits");

    const user = await db.user.create({
      data: {
        collegeId: `${tag}-a`,
        email: `${tag}@rec-code.example`,
        firstName: "Inter",
        lastName: "Author",
        handle: `${tag}-a`,
        role: "ADMIN",
      },
      select: { id: true },
    });
    actorId = user.id;

    const problem = await db.problem.create({
      data: {
        slug: `${tag}-guess`,
        displayCode: `REC-${Math.floor(1000 + Math.random() * 8999)}`,
        title: "Guess the number",
        difficulty: "EASY",
        status: "DRAFT",
      },
      select: { id: true },
    });
    problemId = problem.id;
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    try {
      /**
       * Two cases above freeze a version on purpose — one to prove the
       * mirror CHECK accepts a complete one, one to pin it into an
       * assessment — and a frozen version cannot be deleted: the database
       * refuses every write to it, which is the immutability the whole
       * platform rests on. So the UNFROZEN versions go, the frozen ones
       * stay behind in recx_test under this suite's tag, and the problem
       * row stays with them. A test that disabled a guard to tidy up would
       * teach everybody that guards are negotiable.
       */
      const unfrozen = `SELECT id FROM "ProblemVersion" WHERE "problemId" = $1 AND "frozenAt" IS NULL`;
      await db.$executeRawUnsafe(`DELETE FROM "TestCase" WHERE "problemVersionId" IN (${unfrozen})`, problemId);
      await db.$executeRawUnsafe(
        `DELETE FROM "ProblemVersion" WHERE "problemId" = $1 AND "frozenAt" IS NULL`,
        problemId,
      );
      const left = await db.problemVersion.count({ where: { problemId } });
      if (left === 0) await db.$executeRawUnsafe(`DELETE FROM "Problem" WHERE id = $1`, problemId);
      // A blob a frozen version still names cannot go either.
      const named = await db.problemVersion.findMany({
        where: { problemId },
        select: { interactorSha256: true, checkerSha256: true },
      });
      const held = new Set(named.flatMap((v) => [v.interactorSha256, v.checkerSha256].filter((x): x is string => !!x)));
      await db.testBlob.deleteMany({ where: { sha256: { in: blobShas.filter((s) => !held.has(s)) } } });
      await db.user.deleteMany({ where: { id: actorId } });
    } finally {
      await db.$disconnect();
    }
  }, 60_000);

  describe("what the database says an interactive version is", () => {
    it("refuses a frozen one with no interactor", async () => {
      const v = await version();
      await expect(
        db.$executeRawUnsafe(`UPDATE "ProblemVersion" SET "frozenAt" = now() WHERE id = $1`, v.id),
      ).rejects.toThrow(/interactive_mode_mirror/);
    });

    it("accepts a frozen one that has it", async () => {
      const interactor = await blob(INTERACTOR);
      const v = await version({ interactorSha256: interactor, testlibId: "testlib-0.9.41" });
      await db.$executeRawUnsafe(`UPDATE "ProblemVersion" SET "frozenAt" = now() WHERE id = $1`, v.id);
      const frozen = await db.problemVersion.findUniqueOrThrow({ where: { id: v.id }, select: { frozenAt: true } });
      expect(frozen.frozenAt).not.toBeNull();
    });

    it("refuses an interactor on a version that is not interactive", async () => {
      const interactor = await blob(INTERACTOR);
      await expect(
        version({ compareMode: "TOKEN", interactorSha256: interactor, testlibId: "testlib-0.9.41" }),
      ).rejects.toThrow(/interactive_mode_mirror/);
    });

    it("refuses a conversation on a problem that is not read from stdin", async () => {
      for (const over of [
        { ioMode: "FUNCTION", functionSignature: { methodName: "x", params: [], returns: { kind: "int" }, comparator: "EXACT" } },
        { ioMode: "SQL", sqlDialect: "postgres17", sqlOrdered: true },
      ]) {
        await expect(version(over)).rejects.toThrow(/interactive_stdin_only|sql_mode_mirror/);
      }
    });

    it("refuses a checker beside the interactor, and a float tolerance", async () => {
      const interactor = await blob(INTERACTOR);
      await expect(
        version({ interactorSha256: interactor, testlibId: "testlib-0.9.41", checkerSha256: interactor }),
      ).rejects.toThrow(/interactive_no_checker/);
      await expect(
        version({ interactorSha256: interactor, testlibId: "testlib-0.9.41", floatEpsilon: 1e-6 }),
      ).rejects.toThrow(/interactive_no_epsilon/);
    });
  });

  describe("the assessment rule SPEC asks for", () => {
    it("refuses an interactive version in an assessment, by trigger", async () => {
      const interactor = await blob(INTERACTOR);
      const v = await version({ interactorSha256: interactor, testlibId: "testlib-0.9.41", status: "PUBLISHED" });
      await db.$executeRawUnsafe(`UPDATE "ProblemVersion" SET "frozenAt" = now() WHERE id = $1`, v.id);
      const assessment = await db.assessment.create({
        data: {
          slug: `${tag}-paper`,
          title: "A paper",
          instructions: "Be honest.",
          status: "DRAFT",
          proctorMode: "ADVISORY",
          opensAt: new Date(Date.now() + 86_400_000),
          closesAt: new Date(Date.now() + 90_000_000),
          durationSec: 3_600,
          createdById: actorId,
        } as never,
        select: { id: true },
      });
      try {
        await expect(
          db.assessmentProblem.create({
            data: { assessmentId: assessment.id, problemVersionId: v.id, position: 1, points: 100 },
          }),
        ).rejects.toThrow(/not sat in an assessment yet/);
      } finally {
        await db.$executeRawUnsafe(`DELETE FROM "Assessment" WHERE id = $1`, assessment.id);
      }
    });
  });

  describe("attaching the interactor", () => {
    it("stores it, pins the testlib, and moves judgeSeq", async () => {
      const v = await version();
      const head = await edits.setDraftInteractor({
        versionId: v.id,
        expectedEditSeq: v.editSeq,
        actorId,
        source: INTERACTOR,
      });
      const row = await db.problemVersion.findUniqueOrThrow({
        where: { id: v.id },
        select: { interactorSha256: true, testlibId: true, judgeSeq: true },
      });
      expect(row.interactorSha256).toBe(sha(INTERACTOR));
      expect(row.testlibId).toMatch(/^testlib-/);
      // A judging edit: the validation runs that came before it stop counting.
      expect(row.judgeSeq).toBeGreaterThan(v.judgeSeq);
      expect(head.editSeq).toBeGreaterThan(v.editSeq);
      blobShas.push(sha(INTERACTOR));
    });

    it("removes it with null", async () => {
      const v = await version();
      const first = await edits.setDraftInteractor({ versionId: v.id, expectedEditSeq: v.editSeq, actorId, source: INTERACTOR });
      await edits.setDraftInteractor({ versionId: v.id, expectedEditSeq: first.editSeq, actorId, source: null });
      const row = await db.problemVersion.findUniqueOrThrow({
        where: { id: v.id },
        select: { interactorSha256: true, testlibId: true },
      });
      expect(row.interactorSha256).toBeNull();
      expect(row.testlibId).toBeNull();
    });

    it("is dropped when the version stops being interactive", async () => {
      /**
       * The other half of the mirror CHECK: a TOKEN version carrying an
       * interactor would be refused by the database, so the judging edit
       * clears it rather than leaving the author with a constraint
       * violation they cannot read.
       */
      const v = await version();
      const head = await edits.setDraftInteractor({ versionId: v.id, expectedEditSeq: v.editSeq, actorId, source: INTERACTOR });
      await edits.updateDraftJudging({
        versionId: v.id,
        expectedEditSeq: head.editSeq,
        actorId,
        ioMode: "STDIN",
        functionSignature: null,
        compareMode: "TOKEN",
        floatEpsilon: null,
        scoringMode: "ICPC",
        stopOnFirstFailure: true,
        timeLimitMs: 2000,
        memoryLimitKb: 262_144,
      });
      const row = await db.problemVersion.findUniqueOrThrow({
        where: { id: v.id },
        select: { compareMode: true, interactorSha256: true },
      });
      expect(row.compareMode).toBe("TOKEN");
      expect(row.interactorSha256).toBeNull();
    });

    it("clears a float tolerance when the version becomes interactive", async () => {
      const v = await version({ compareMode: "FLOAT", floatEpsilon: 1e-6 });
      await edits.updateDraftJudging({
        versionId: v.id,
        expectedEditSeq: v.editSeq,
        actorId,
        ioMode: "STDIN",
        functionSignature: null,
        compareMode: "INTERACTIVE",
        floatEpsilon: 1e-6,
        scoringMode: "ICPC",
        stopOnFirstFailure: true,
        timeLimitMs: 2000,
        memoryLimitKb: 262_144,
      });
      const row = await db.problemVersion.findUniqueOrThrow({
        where: { id: v.id },
        select: { compareMode: true, floatEpsilon: true },
      });
      expect(row.compareMode).toBe("INTERACTIVE");
      expect(row.floatEpsilon).toBeNull();
    });
  });
});
