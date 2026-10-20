import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildZip, packageFiles, type ZipEntry } from "./support/zip";

/**
 * Bulk import against a real Postgres (recx_test): one bad entry cannot
 * discard a 300-item batch, re-importing is idempotent, and the per-slug
 * rules (NEW_REVISION, open draft, display-code clash) hold.
 *
 * Opt-in: RECX_DB_TESTS=1 (RECX_TEST_DATABASE_URL must name a *_test database).
 * The test-data store is an in-memory fake; audit() is a spy.
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";
const TEST_URL = process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";

const h = vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL = process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";
  }
  const objects = new Map<string, Buffer>();
  return {
    objects,
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

vi.mock("@/lib/testdata/store", () => ({ getTestDataStore: () => h.store }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

type Modules = {
  db: (typeof import("@/lib/db"))["db"];
  archive: typeof import("@/lib/authoring/import/archive");
  run: typeof import("@/lib/authoring/import/run");
  fixtures: typeof import("./support/authoring-fixtures");
};

const COUNT = 300;
const CORRUPT = 150;

describe.skipIf(!ENABLED)("bulk problem import (recx_test)", () => {
  const tag = `imp-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let m: Modules;
  let dir = "";
  let base = 0;
  let adminId = "";
  const importIds: string[] = [];
  const userIds: string[] = [];

  const slugOf = (i: number) => `${tag}-p${i}`;
  const entriesFor = (i: number, overrides: Record<string, string | Buffer | null> = {}): ZipEntry[] =>
    Object.entries(packageFiles(slugOf(i), base + i, overrides)).map(([name, data]) => ({ name: `${slugOf(i)}/${name}`, data }));

  async function importZip(entries: readonly ZipEntry[]) {
    const file = path.join(dir, `${importIds.length}.zip`);
    await writeFile(file, buildZip(entries));
    const record = await m.db.problemImport.create({
      data: { uploadedById: adminId, fileName: path.basename(file), sizeBytes: BigInt(1), archiveSha256: "0".repeat(64), via: "test" },
      select: { id: true },
    });
    importIds.push(record.id);
    const results = await m.run.runProblemImport(record.id, await m.archive.openZipArchive(file), adminId);
    const row = await m.db.problemImport.findUniqueOrThrow({ where: { id: record.id } });
    return { results, row };
  }

  const count = (results: { status: string }[], status: string) => results.filter((r) => r.status === status).length;

  beforeAll(async () => {
    if (!new URL(TEST_URL).pathname.endsWith("_test")) {
      throw new Error(`Refusing to run against a non-test database: ${new URL(TEST_URL).pathname}`);
    }
    const [dbModule, archive, run, fixtures] = await Promise.all([
      import("@/lib/db"),
      import("@/lib/authoring/import/archive"),
      import("@/lib/authoring/import/run"),
      import("./support/authoring-fixtures"),
    ]);
    m = { db: dbModule.db, archive, run, fixtures };
    dir = await mkdtemp(path.join(os.tmpdir(), "recx-import-db-"));
    adminId = (await fixtures.createUser(m.db, tag, "importer", "ADMIN")).id;
    userIds.push(adminId);
    // A window of REC-NNNN codes nobody uses (other tests and the seed own theirs).
    const taken = new Set(
      (await m.db.problem.findMany({ where: { displayCode: { startsWith: "REC-" } }, select: { displayCode: true } })).map((p) => p.displayCode),
    );
    for (base = 1000 + Math.floor(Math.random() * 5000); ; base += 400) {
      const free = Array.from({ length: COUNT + 10 }, (_, i) => `REC-${String(base + i).padStart(4, "0")}`).every((c) => !taken.has(c));
      if (free && base + COUNT + 10 < 9000) break;
      if (base > 8500) base = 1000;
    }
  }, 60_000);

  afterAll(async () => {
    if (!m) return;
    try {
      const problems = await m.db.problem.findMany({ where: { slug: { startsWith: `${tag}-` } }, select: { id: true } });
      const problemIds = problems.map((p) => p.id);
      const tests = await m.db.testCase.findMany({
        where: { problemVersion: { problemId: { in: problemIds } } },
        select: { inputSha256: true, outputSha256: true },
      });
      const blobShas = [...new Set(tests.flatMap((t) => [t.inputSha256, t.outputSha256]))];
      await m.fixtures.cleanup(m.db, { problemIds, userIds, blobShas, importIds });
    } finally {
      await m.db.$disconnect();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it(`imports ${COUNT} entries with entry #${CORRUPT} corrupt: ${COUNT - 1} CREATED, 1 FAILED; re-import is UNCHANGED; the fix CREATES 1`, async () => {
    const all = (corrupt: boolean) =>
      Array.from({ length: COUNT }, (_, i) =>
        i === CORRUPT && corrupt ? entriesFor(i).map((e) => (e.name.endsWith("statement.md") ? { ...e, badCrc: true } : e)) : entriesFor(i),
      ).flat();

    const first = await importZip(all(true));
    expect(first.results).toHaveLength(COUNT);
    expect(count(first.results, "CREATED")).toBe(COUNT - 1);
    expect(count(first.results, "FAILED")).toBe(1);
    const failed = first.results.find((r) => r.status === "FAILED")!;
    expect(failed.entry).toBe(slugOf(CORRUPT));
    expect(failed.errors[0]?.path).toBe("statement.md");
    expect(first.row).toMatchObject({ status: "DONE", total: COUNT, created: COUNT - 1, failed: 1, unchanged: 0, revised: 0 });
    expect(await m.db.problemImportRow.count({ where: { importId: importIds[0]! } })).toBe(COUNT);
    const { getImport, listMyImports } = await import("@/server/queries/admin-problems");
    const view = await getImport({ id: adminId, role: "ADMIN" }, importIds[0]!);
    expect(view?.summary).toMatchObject({ status: "DONE", created: COUNT - 1, failed: 1, total: COUNT });
    expect(view?.rows[0]).toMatchObject({ status: "FAILED", entry: slugOf(CORRUPT) });
    expect(view?.rows[0]?.errors[0]?.message).toMatch(/CRC-32/);
    expect((await listMyImports({ id: adminId, role: "ADMIN" })).map((i) => i.id)).toContain(importIds[0]);

    // Every created problem is a DRAFT r1 with its tests, solutions and topic; no bundle was written.
    const sample = await m.db.problem.findUniqueOrThrow({
      where: { slug: slugOf(7) },
      include: { tags: true, versions: { include: { testCases: true, referenceSolutions: true, hints: true, editorial: true, starterCodes: true } } },
    });
    expect(sample).toMatchObject({ status: "DRAFT", liveVersionId: null, displayCode: `REC-${String(base + 7).padStart(4, "0")}` });
    expect(sample.tags.map((t) => t.topic)).toEqual(["STRINGS"]);
    const v = sample.versions[0]!;
    expect(v).toMatchObject({ revision: 1, status: "DRAFT", frozenAt: null, bundleKey: null, origin: "FACULTY", createdById: adminId });
    expect(v.importSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(v.testCases).toHaveLength(2);
    expect(v.referenceSolutions.map((r) => r.expectedVerdict).sort()).toEqual(["AC", "WA"]);
    expect(v.hints).toHaveLength(1);
    expect(v.editorial).not.toBeNull();
    expect(v.starterCodes.map((s) => s.language)).toEqual(["py312"]);
    expect([...h.objects.keys()].some((k) => k.startsWith("problems/"))).toBe(false);

    const ours = async () => {
      const rows = await m.db.testCase.findMany({
        where: { problemVersion: { problem: { slug: { startsWith: `${tag}-` } } } },
        select: { inputSha256: true, outputSha256: true },
      });
      // Sorted: findMany has no stable row order, and the comparison is about the set.
      return { testCases: rows.length, shas: [...new Set(rows.flatMap((r) => [r.inputSha256, r.outputSha256]))].sort() };
    };
    const before = await ours();
    const again = await importZip(all(true));
    expect(count(again.results, "UNCHANGED")).toBe(COUNT - 1);
    expect(count(again.results, "FAILED")).toBe(1);
    // Nothing new: no test rows, and each blob is stored once (content-addressed).
    const after = await ours();
    expect(after).toEqual(before);
    expect(await m.db.testBlob.count({ where: { sha256: { in: after.shas } } })).toBe(after.shas.length);

    const fixed = await importZip(all(false));
    expect(count(fixed.results, "CREATED")).toBe(1);
    expect(count(fixed.results, "UNCHANGED")).toBe(COUNT - 1);
    expect(fixed.results.find((r) => r.status === "CREATED")?.entry).toBe(slugOf(CORRUPT));
  }, 600_000);

  it("adds a NEW_REVISION when the live revision differs, refuses over an open draft, and refuses a display-code clash", async () => {
    // Publish p0's revision 1 by hand (freezing is the one permitted write).
    const p0 = await m.db.problem.findUniqueOrThrow({ where: { slug: slugOf(0) }, include: { versions: true } });
    const r1 = p0.versions[0]!;
    const now = new Date();
    await m.db.problemVersion.update({ where: { id: r1.id }, data: { status: "PUBLISHED", frozenAt: now, publishedAt: now } });
    await m.db.problem.update({ where: { id: p0.id }, data: { liveVersionId: r1.id, status: "PUBLISHED" } });

    const same = await importZip(entriesFor(0));
    expect(same.results[0]).toMatchObject({ status: "UNCHANGED", revision: 1 });

    const changed = await importZip(entriesFor(0, { "statement.md": "A clearer statement." }));
    expect(changed.results[0]).toMatchObject({ status: "NEW_REVISION", revision: 2 });
    const topicsChanged = JSON.parse(packageFiles(slugOf(0), base)["meta.json"] as string) as Record<string, unknown>;
    topicsChanged.topics = ["GRAPHS"];

    const overDraft = await importZip(entriesFor(0, { "statement.md": "Yet another statement.", "meta.json": JSON.stringify(topicsChanged) }));
    expect(overDraft.results[0]).toMatchObject({ status: "FAILED" });
    expect(overDraft.results[0]!.errors[0]!.message).toMatch(/Revision 2 of .* is an open draft; finish or delete it first/);

    const draftAgain = await importZip(entriesFor(0, { "statement.md": "A clearer statement." }));
    expect(draftAgain.results[0]).toMatchObject({ status: "UNCHANGED", revision: 2 });

    // A new slug that reuses p1's display code.
    const clashMeta = JSON.parse(packageFiles(`${tag}-clash`, base + 1)["meta.json"] as string) as Record<string, unknown>;
    const clash = await importZip(
      Object.entries({ ...packageFiles(`${tag}-clash`, base + 1), "meta.json": JSON.stringify(clashMeta) }).map(([name, data]) => ({
        name: `${tag}-clash/${name}`,
        data,
      })),
    );
    expect(clash.results[0]).toMatchObject({ status: "FAILED" });
    expect(clash.results[0]!.errors[0]!.message).toMatch(/already used by/);

    // The same slug with a different display code.
    const mismatch = await importZip(entriesFor(1).map((e) => (e.name.endsWith("meta.json") ? { ...e, data: String(e.data).replace(`REC-${String(base + 1).padStart(4, "0")}`, "REC-0001") } : e)));
    expect(mismatch.results[0]).toMatchObject({ status: "FAILED" });
    expect(mismatch.results[0]!.errors[0]!.message).toMatch(/has display code/);
  }, 120_000);
});
