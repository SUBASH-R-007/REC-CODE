import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Prisma } from "../src/index";
import { FROZEN_CHILD_MODELS } from "../src/frozen";
import { FACTORIES, type FactoryContext } from "./support/frozen-factories";
import {
  applyMigrations,
  disabledTriggers,
  openTestDb,
  RUN_DB_TESTS,
  testDatabaseName,
  type DbModule,
  type TestDb,
} from "./support/test-db";

/**
 * Structural decision (a), database half: for EVERY frozen child model
 * (FROZEN_CHILD_MODELS) both fences refuse every write once the version is
 * frozen — the repository guard (FrozenVersionError, every Prisma write
 * operation including the *AndReturn ones) and the database trigger (raw
 * INSERT / UPDATE / DELETE). Also: nested writes the guard cannot see, a
 * version created frozen, TestBlob immutability, and the Phase 4
 * ProblemVersion columns freezing with the version.
 *
 * DB-backed: runs only with RECX_DB_TESTS=1, against recx_test (never recx).
 * frozen-coverage.test.ts keeps FACTORIES equal to FROZEN_CHILD_MODELS.
 */

const TITLE = RUN_DB_TESTS
  ? "frozen children: every model, every operation (recx_test)"
  : "frozen children [skipped: set RECX_DB_TESTS=1 to run against recx_test on localhost:5433]";

const FROZEN = /frozen/i;
const BORN_FROZEN = "A revision is frozen by publishing it, never created frozen.";
const CHILDREN = [...FROZEN_CHILD_MODELS].sort();

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const rid = (prefix: string) => `${prefix}-${randomBytes(6).toString("hex")}`;

/** The slice of a Prisma model delegate these tests drive, for any child model. */
interface Delegate {
  create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
  createMany(args: { data: Record<string, unknown>[] }): Promise<{ count: number }>;
  createManyAndReturn(args: { data: Record<string, unknown>[] }): Promise<Array<{ id: string }>>;
  update(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ id: string }>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
  updateManyAndReturn(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<Array<{ id: string }>>;
  upsert(args: {
    where: Record<string, unknown>;
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }): Promise<{ id: string }>;
  delete(args: { where: Record<string, unknown> }): Promise<{ id: string }>;
  deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
  count(args: { where: Record<string, unknown> }): Promise<number>;
  findUniqueOrThrow(args: { where: Record<string, unknown> }): Promise<Record<string, unknown>>;
}

describe.skipIf(!RUN_DB_TESTS)(TITLE, () => {
  let mod: DbModule;
  let db: TestDb;
  let restoreEnv: () => void = () => {};
  const tag = `fc-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const blobs = { in: `${tag} input\n`, out: `${tag} output\n`, ro: `${tag} immutable blob\n` };
  const ctx: FactoryContext = { inputSha256: sha256(blobs.in), outputSha256: sha256(blobs.out) };
  const problemIds: string[] = [];

  const delegate = (model: string) => (db as unknown as Record<string, Delegate>)[lowerFirst(model)]!;

  /** A problem with two draft revisions (1 and 2). */
  async function makeProblem(suffix: string): Promise<{ problemId: string; v1: string; v2: string }> {
    const slug = `${tag}-${suffix}`.toLowerCase();
    const problem = await db.problem.create({
      data: { slug, displayCode: `T-${slug}`, title: `Frozen children ${suffix}`, difficulty: "EASY" },
    });
    problemIds.push(problem.id);
    const version = (revision: number) => ({
      problemId: problem.id,
      revision,
      title: `Frozen children ${suffix} r${revision}`,
      difficulty: "EASY" as const,
      statementMd: "Echo the input.",
      ioMode: "STDIN" as const,
      timeLimitMs: 1000,
    });
    const v1 = (await db.problemVersion.create({ data: version(1) })).id;
    const v2 = (await db.problemVersion.create({ data: version(2) })).id;
    return { problemId: problem.id, v1, v2 };
  }

  /** The publish transition: the one permitted write that freezes a version. */
  async function freeze(versionId: string) {
    const now = new Date();
    await db.problemVersion.update({
      where: { id: versionId },
      data: { status: "PUBLISHED", frozenAt: now, publishedAt: now },
    });
  }

  /**
   * The same row in Prisma's "checked" create form: relations by connect
   * instead of foreign-key scalars (TestCase also connects its two blobs).
   */
  function connectForm(model: string, row: Record<string, unknown>): Record<string, unknown> {
    const { problemVersionId, inputSha256, outputSha256, ...rest } = row;
    const out: Record<string, unknown> = { ...rest, problemVersion: { connect: { id: problemVersionId } } };
    if (model === "TestCase") {
      out.input = { connect: { sha256: inputSha256 } };
      out.output = { connect: { sha256: outputSha256 } };
    }
    return out;
  }

  /** A raw INSERT of a complete row of `model` (json_populate_record fills every column). */
  function rawInsert(model: string, row: Record<string, unknown>) {
    return db.$executeRawUnsafe(
      `INSERT INTO "public"."${model}" SELECT * FROM json_populate_record(NULL::"public"."${model}", $1::json)`,
      JSON.stringify({ id: rid("raw"), createdAt: new Date().toISOString(), ...row }),
    );
  }

  beforeAll(async () => {
    const dbName = testDatabaseName();
    applyMigrations();
    ({ mod, db, restore: restoreEnv } = await openTestDb());
    const [current] = await db.$queryRawUnsafe<Array<{ name: string }>>("SELECT current_database() AS name");
    expect(current?.name).toBe(dbName);
    await db.testBlob.createMany({
      data: Object.values(blobs).map((text) => ({ sha256: sha256(text), sizeBytes: Buffer.byteLength(text), inline: text })),
    });
  });

  afterAll(async () => {
    try {
      if (db && problemIds.length > 0) {
        // The triggers refuse deletes under a frozen version, by design. Teardown
        // lifts them inside ONE transaction (DDL is transactional in Postgres, so
        // no other session ever sees them disabled) and re-enables them.
        const guarded: Array<[table: string, trigger: string]> = [
          ...CHILDREN.map((m): [string, string] => [m, `${m}_frozen_guard`]),
          ["ProblemVersion", "ProblemVersion_frozen_guard"],
        ];
        const versions = `SELECT "id" FROM "ProblemVersion" WHERE "problemId" = ANY($1::text[])`;
        await db.$transaction([
          ...guarded.map(([table, trigger]) => db.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`)),
          ...CHILDREN.map((m) =>
            db.$executeRawUnsafe(`DELETE FROM "${m}" WHERE "problemVersionId" IN (${versions})`, problemIds),
          ),
          db.$executeRawUnsafe(`DELETE FROM "ProblemReview" WHERE "problemVersionId" IN (${versions})`, problemIds),
          db.$executeRawUnsafe(`DELETE FROM "ProblemVersion" WHERE "problemId" = ANY($1::text[])`, problemIds),
          ...guarded.map(([table, trigger]) => db.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER "${trigger}"`)),
          db.$executeRawUnsafe(`DELETE FROM "Problem" WHERE "id" = ANY($1::text[])`, problemIds),
          db.$executeRawUnsafe(`DELETE FROM "TestBlob" WHERE "sha256" = ANY($1::text[])`, Object.values(blobs).map(sha256)),
        ]);
        expect(await db.problem.count({ where: { id: { in: problemIds } } })).toBe(0);
      }
      if (db) expect(await disabledTriggers(db)).toEqual([]);
    } finally {
      await db?.$disconnect();
      restoreEnv();
    }
  });

  it.each(CHILDREN)("%s: draft writes allowed; after freeze every operation is refused by both fences", async (model) => {
    const { FrozenVersionError } = mod;
    const f = FACTORIES[model]!;
    const m = delegate(model);
    const { v1, v2 } = await makeProblem(model);

    // ── Draft: every operation is allowed (v1 keeps one row; v2 is the scratch draft).
    const r1 = await m.create({ data: f.create(v1, 1, ctx) });
    await expect(m.update({ where: { id: r1.id }, data: f.edit })).resolves.toBeTruthy();
    await expect(m.upsert({ where: { id: r1.id }, create: f.create(v1, 1, ctx), update: f.edit })).resolves.toBeTruthy();
    expect(await m.createManyAndReturn({ data: [f.create(v2, 1, ctx)] })).toHaveLength(1);
    expect(await m.updateManyAndReturn({ where: { problemVersionId: v2 }, data: f.edit })).toHaveLength(1);
    expect((await m.updateMany({ where: { problemVersionId: v2 }, data: f.edit })).count).toBe(1);
    expect((await m.deleteMany({ where: { problemVersionId: v2 } })).count).toBe(1);
    expect((await m.createMany({ data: [f.create(v2, 1, ctx)] })).count).toBe(1);
    expect((await m.deleteMany({ where: { problemVersionId: v2 } })).count).toBe(1);
    const scratch = await m.create({ data: f.create(v2, 1, ctx) });
    await expect(m.delete({ where: { id: scratch.id } })).resolves.toBeTruthy();
    // Raw SQL on a draft is allowed too (control for the trigger assertions below).
    expect(await rawInsert(model, f.create(v2, 1, ctx))).toBe(1);
    expect(await db.$executeRawUnsafe(`UPDATE "${model}" SET "problemVersionId" = "problemVersionId" WHERE "problemVersionId" = $1`, v2)).toBe(1);
    expect(await db.$executeRawUnsafe(`DELETE FROM "${model}" WHERE "problemVersionId" = $1`, v2)).toBe(1);
    const draftChild = await m.create({ data: f.create(v2, 1, ctx) });

    // ── Freeze v1.
    await freeze(v1);
    const before = await m.findUniqueOrThrow({ where: { id: r1.id } });

    // ── Repository guard: FrozenVersionError for every operation.
    const refused = [
      () => m.create({ data: f.create(v1, 2, ctx) }),
      () => m.create({ data: connectForm(model, f.create(v1, 3, ctx)) }),
      () => m.createMany({ data: [f.create(v1, 2, ctx)] }),
      () => m.createManyAndReturn({ data: [f.create(v1, 2, ctx)] }),
      () => m.update({ where: { id: r1.id }, data: f.edit }),
      () => m.updateMany({ where: { problemVersionId: v1 }, data: f.edit }),
      () => m.updateManyAndReturn({ where: { problemVersionId: v1 }, data: f.edit }),
      () => m.upsert({ where: { id: r1.id }, create: f.create(v1, 2, ctx), update: f.edit }),
      // An upsert that would INSERT into the frozen version.
      () => m.upsert({ where: { id: rid("missing") }, create: f.create(v1, 2, ctx), update: f.edit }),
      () => m.delete({ where: { id: r1.id } }),
      () => m.deleteMany({ where: { problemVersionId: v1 } }),
      // Moving a draft's child into the frozen version, three ways.
      () => m.update({ where: { id: draftChild.id }, data: { problemVersionId: v1 } }),
      () => m.update({ where: { id: draftChild.id }, data: { problemVersion: { connect: { id: v1 } } } }),
      () => m.updateMany({ where: { id: draftChild.id }, data: { problemVersionId: v1 } }),
      () => m.upsert({ where: { id: draftChild.id }, create: f.create(v2, 2, ctx), update: { problemVersionId: v1 } }),
    ];
    for (const [i, op] of refused.entries()) {
      await expect(op(), `${model} guard op #${i}`).rejects.toBeInstanceOf(FrozenVersionError);
    }

    // ── Database trigger: raw INSERT / UPDATE / DELETE / move.
    await expect(rawInsert(model, f.create(v1, 2, ctx))).rejects.toThrow(FROZEN);
    await expect(db.$executeRawUnsafe(`UPDATE "${model}" SET "problemVersionId" = "problemVersionId" WHERE "id" = $1`, r1.id)).rejects.toThrow(FROZEN);
    await expect(db.$executeRawUnsafe(`DELETE FROM "${model}" WHERE "id" = $1`, r1.id)).rejects.toThrow(FROZEN);
    await expect(db.$executeRawUnsafe(`DELETE FROM "${model}" WHERE "problemVersionId" = $1`, v1)).rejects.toThrow(FROZEN);
    await expect(
      db.$executeRawUnsafe(`UPDATE "${model}" SET "problemVersionId" = $1 WHERE "id" = $2`, v1, draftChild.id),
    ).rejects.toThrow(FROZEN);

    // Nothing changed under the frozen version, and the draft child stayed put.
    expect(await m.count({ where: { problemVersionId: v1 } })).toBe(1);
    expect(await m.findUniqueOrThrow({ where: { id: r1.id } })).toEqual(before);
    expect(await m.count({ where: { problemVersionId: v2 } })).toBe(1);
  });

  describe("version level", () => {
    let frozenId = "";
    let draftId = "";
    let problemId = "";

    beforeAll(async () => {
      ({ problemId, v1: frozenId, v2: draftId } = await makeProblem("version"));
      // Every Phase 4 authoring column is writable on the draft, through review…
      await db.problemVersion.update({
        where: { id: frozenId },
        data: {
          origin: "SENIOR_STUDENT",
          editSeq: { increment: 1 },
          judgeSeq: { increment: 1 },
          lastEditedById: "author-1",
          submittedForReviewAt: new Date(),
          submittedById: "author-1",
          status: "IN_REVIEW",
          approvedAt: new Date(),
          approvedById: "reviewer-1",
          importSha256: sha256(`${tag} package`),
        },
      });
      await db.problemReview.create({ data: { problemVersionId: frozenId, action: "APPROVED", actorId: "reviewer-1" } });
      // …then the publish transition freezes them with the version.
      await freeze(frozenId);
    });

    const PHASE4_COLUMNS: Array<[column: string, value: unknown, sql: string]> = [
      ["origin", "AI_ASSISTED", `"origin" = 'AI_ASSISTED'`],
      ["editSeq", 99, `"editSeq" = 99`],
      ["judgeSeq", 99, `"judgeSeq" = 99`],
      ["lastEditedById", "someone-else", `"lastEditedById" = 'someone-else'`],
      ["updatedAt", new Date(0), `"updatedAt" = now()`],
      ["submittedForReviewAt", null, `"submittedForReviewAt" = NULL`],
      ["submittedById", null, `"submittedById" = NULL`],
      ["approvedAt", null, `"approvedAt" = NULL`],
      ["approvedById", "someone-else", `"approvedById" = 'someone-else'`],
      ["importSha256", null, `"importSha256" = NULL`],
    ];

    it.each(PHASE4_COLUMNS)("the Phase 4 column %s is immutable after freeze (guard and trigger)", async (column, value, sql) => {
      const before = await db.problemVersion.findUniqueOrThrow({ where: { id: frozenId } });
      const data = { [column]: value } as Prisma.ProblemVersionUncheckedUpdateManyInput;
      await expect(db.problemVersion.update({ where: { id: frozenId }, data })).rejects.toBeInstanceOf(mod.FrozenVersionError);
      await expect(db.problemVersion.update({ where: { id: frozenId }, data })).rejects.toMatchObject({ code: "frozen" });
      await expect(db.problemVersion.updateManyAndReturn({ where: { id: frozenId }, data })).rejects.toBeInstanceOf(
        mod.FrozenVersionError,
      );
      await expect(db.$executeRawUnsafe(`UPDATE "ProblemVersion" SET ${sql} WHERE "id" = $1`, frozenId)).rejects.toThrow(FROZEN);
      expect(await db.problemVersion.findUniqueOrThrow({ where: { id: frozenId } })).toEqual(before);
    });

    it("refuses a nested version update through Problem (the database trigger catches what the guard cannot see)", async () => {
      await expect(
        db.problem.update({
          where: { id: problemId },
          data: { versions: { update: { where: { id: frozenId }, data: { statementMd: "nested edit" } } } },
        }),
      ).rejects.toThrow(FROZEN);
      await expect(
        db.problem.update({
          where: { id: problemId },
          data: { versions: { updateMany: { where: { id: frozenId }, data: { judgeSeq: 7 } } } },
        }),
      ).rejects.toThrow(FROZEN);
      expect((await db.problemVersion.findUniqueOrThrow({ where: { id: frozenId } })).statementMd).toBe("Echo the input.");
    });

    it("refuses a nested child create through problemVersion.update", async () => {
      await expect(
        db.problemVersion.update({
          where: { id: frozenId },
          data: { testCases: { create: { index: 40, isSample: false, inputSha256: ctx.inputSha256, outputSha256: ctx.outputSha256 } } },
        }),
      ).rejects.toBeInstanceOf(mod.FrozenVersionError);
      await expect(
        db.problemVersion.update({ where: { id: frozenId }, data: { hints: { create: { tier: 1, contentMd: "late hint" } } } }),
      ).rejects.toBeInstanceOf(mod.FrozenVersionError);
      expect(await db.testCase.count({ where: { problemVersionId: frozenId } })).toBe(0);
      expect(await db.hint.count({ where: { problemVersionId: frozenId } })).toBe(0);
    });

    it("refuses retiring a frozen version: RETIRED is written to Problem only", async () => {
      await expect(db.problemVersion.update({ where: { id: frozenId }, data: { status: "RETIRED" } })).rejects.toBeInstanceOf(
        mod.FrozenVersionError,
      );
      await expect(
        db.$executeRawUnsafe(`UPDATE "ProblemVersion" SET "status" = 'RETIRED' WHERE "id" = $1`, frozenId),
      ).rejects.toThrow(FROZEN);
    });

    it("keeps review history writable after freeze (ProblemReview is exempt)", async () => {
      await expect(
        db.problemReview.create({ data: { problemVersionId: frozenId, action: "APPROVAL_REVOKED", comment: "history only" } }),
      ).resolves.toBeTruthy();
      expect(await db.problemReview.count({ where: { problemVersionId: frozenId } })).toBe(2);
    });

    it("refuses a version created frozen (guard, nested create and raw INSERT)", async () => {
      /** A frozen revision's fields, without the problem (for nested creates). */
      const bornContent = (revision: number) => ({
        revision,
        title: "born frozen",
        difficulty: "EASY" as const,
        statementMd: "x",
        ioMode: "STDIN" as const,
        timeLimitMs: 1000,
        status: "PUBLISHED" as const,
        frozenAt: new Date(),
        publishedAt: new Date(),
      });
      const born = (revision: number) => ({ problemId, ...bornContent(revision) });
      await expect(db.problemVersion.create({ data: born(10) })).rejects.toThrow(BORN_FROZEN);
      await expect(db.problemVersion.create({ data: born(10) })).rejects.toBeInstanceOf(mod.FrozenVersionError);
      // The code tells apps/web this is a bug in the caller, not a user conflict.
      await expect(db.problemVersion.create({ data: born(10) })).rejects.toMatchObject({ code: "born_frozen" });
      await expect(db.problemVersion.createMany({ data: [born(11)] })).rejects.toThrow(BORN_FROZEN);
      await expect(db.problemVersion.createManyAndReturn({ data: [{ ...born(12), frozenAt: new Date().toISOString() }] })).rejects.toThrow(
        BORN_FROZEN,
      );
      await expect(
        db.problemVersion.upsert({ where: { id: rid("missing") }, create: born(13), update: { title: "x" } }),
      ).rejects.toThrow(BORN_FROZEN);
      // Nested creates bypass the guard; the BEFORE INSERT trigger refuses them.
      await expect(
        db.problem.update({ where: { id: problemId }, data: { versions: { create: bornContent(14) } } }),
      ).rejects.toThrow(FROZEN);
      const nestedSlug = `${tag}-nested-born`;
      await expect(
        db.problem.create({
          data: {
            slug: nestedSlug,
            displayCode: `T-${nestedSlug}`,
            title: "nested born frozen",
            difficulty: "EASY",
            versions: { create: bornContent(1) },
          },
        }),
      ).rejects.toThrow(FROZEN);
      expect(await db.problem.count({ where: { slug: nestedSlug } })).toBe(0);
      await expect(
        db.$executeRawUnsafe(
          `INSERT INTO "ProblemVersion" ("id", "problemId", "revision", "status", "title", "difficulty", "statementMd", "ioMode", "timeLimitMs", "frozenAt")
           VALUES ($1, $2, 15, 'PUBLISHED', 'raw born frozen', 'EASY', 'x', 'STDIN', 1000, now())`,
          rid("raw-born"),
          problemId,
        ),
      ).rejects.toThrow(/created frozen/i);
      expect(await db.problemVersion.count({ where: { problemId, revision: { gte: 10 } } })).toBe(0);
      // An explicit null is an ordinary draft.
      const draft = await db.problemVersion.create({ data: { ...born(16), status: "DRAFT", frozenAt: null, publishedAt: null } });
      expect(draft.frozenAt).toBeNull();
    });

    it("still allows every write to a draft version", async () => {
      await expect(db.problemVersion.update({ where: { id: draftId }, data: { statementMd: "draft edit", editSeq: { increment: 1 } } })).resolves.toBeTruthy();
      await expect(db.problemVersion.updateManyAndReturn({ where: { id: draftId }, data: { judgeSeq: { increment: 1 } } })).resolves.toHaveLength(1);
    });
  });

  describe("TestBlob", () => {
    const ro = sha256(blobs.ro);

    it("refuses any change of a blob's content (Prisma and raw SQL)", async () => {
      const before = await db.testBlob.findUniqueOrThrow({ where: { sha256: ro } });
      const immutable = /immutable/i;
      await expect(db.testBlob.update({ where: { sha256: ro }, data: { inline: "rewritten\n" } })).rejects.toThrow(immutable);
      await expect(db.testBlob.update({ where: { sha256: ro }, data: { sizeBytes: 1 } })).rejects.toThrow(immutable);
      await expect(db.testBlob.update({ where: { sha256: ro }, data: { storageKey: "blobs/other" } })).rejects.toThrow(immutable);
      await expect(
        db.testBlob.upsert({ where: { sha256: ro }, create: { sha256: ro, sizeBytes: 1, inline: "x" }, update: { inline: "x" } }),
      ).rejects.toThrow(immutable);
      await expect(db.$executeRawUnsafe(`UPDATE "TestBlob" SET "inline" = 'raw rewrite' WHERE "sha256" = $1`, ro)).rejects.toThrow(
        immutable,
      );
      await expect(
        db.$executeRawUnsafe(`UPDATE "TestBlob" SET "sha256" = $1 WHERE "sha256" = $2`, sha256("other"), ro),
      ).rejects.toThrow(immutable);
      expect(await db.testBlob.findUniqueOrThrow({ where: { sha256: ro } })).toEqual(before);
    });

    it("accepts a no-op upsert of an existing sha (ensureTestBlob's pattern) and a no-op UPDATE", async () => {
      const before = await db.testBlob.findUniqueOrThrow({ where: { sha256: ro } });
      await expect(
        db.testBlob.upsert({
          where: { sha256: ro },
          create: { sha256: ro, sizeBytes: Buffer.byteLength(blobs.ro), inline: blobs.ro },
          update: {},
        }),
      ).resolves.toMatchObject({ sha256: ro });
      expect(await db.$executeRawUnsafe(`UPDATE "TestBlob" SET "inline" = "inline" WHERE "sha256" = $1`, ro)).toBe(1);
      expect(await db.testBlob.findUniqueOrThrow({ where: { sha256: ro } })).toEqual(before);
    });
  });
});
