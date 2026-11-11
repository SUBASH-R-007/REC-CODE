import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The aptitude import pipeline against recx_test (Phase 16k,
 * `docs/ROADMAP.md` §1.2).
 *
 * The bank itself — that every row is valid, that every question would pass
 * the publish gate, and that all six seeded patterns draw a full paper twice
 * over — is proved without a database in `aptitude-bank.test.ts`.
 * `buildMockLayout` is a pure function, so the draw needs no rows.
 *
 * What needs a database is the PIPELINE, and it is tested here on a small
 * batch this file generates rather than on the authored CSVs. That is not a
 * convenience. A published or retired aptitude question is **never deleted**
 * (`recx_refuse_published_question_change`, and it is right: answer rows
 * reference it and past results must stay honest), so a suite that imported
 * and published the real bank could not clean up — and the importer's
 * content-hash duplicate detector would then refuse that content for ever,
 * leaving a long-lived recx_test permanently unable to run it. Generated
 * rows, deleted while still DRAFT, keep this suite repeatable.
 *
 * What it pins:
 *   * a clean file imports every row as DRAFT, with the area derived from
 *     the topic and the origin it was given;
 *   * one bad row fails on its own and the rest of the file still imports,
 *     which is SPEC §5's whole requirement;
 *   * the author cannot publish their own question, which is why Phase 16k
 *     closes only half of §1.2 — the review is a person's;
 *   * re-importing the same content creates nothing.
 *
 * Opt-in: RECX_DB_TESTS=1.
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";

vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";
    process.env.IP_HASH_PEPPER ??= "aptitude-import-test-pepper";
  }
});

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));

/** The acting super-admin for the publish action. */
let actorId = "";
vi.mock("@/lib/auth/guards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/guards")>();
  return {
    ...actual,
    requireSuperAdmin: async () => ({ id: actorId, role: "SUPER_ADMIN" as const }),
  };
});

describe.skipIf(!ENABLED)("the aptitude import pipeline against recx_test", () => {
  const tag = `aptimp-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let db: (typeof import("@/lib/db"))["db"];
  let runAptitudeImport: (typeof import("@/lib/aptitude/import"))["runAptitudeImport"];
  let publishAptitudeQuestion: (typeof import("@/server/actions/super-aptitude"))["publishAptitudeQuestion"];
  let shared: typeof import("@recx/shared");
  const userIds: string[] = [];
  let authorId = "";
  const importedIds: string[] = [];

  async function staff(suffix: string): Promise<string> {
    const row = await db.user.create({
      data: {
        collegeId: `${tag}-${suffix}`.toUpperCase().slice(0, 32),
        email: `${tag}-${suffix}@rajalakshmi.edu.invalid`,
        firstName: "Import",
        lastName: suffix,
        handle: `${tag}-${suffix}`.slice(0, 30),
        role: "SUPER_ADMIN",
        status: "ACTIVE",
        passwordHash: null,
      },
      select: { id: true },
    });
    userIds.push(row.id);
    return row.id;
  }

  /**
   * A small CSV this run invents, in the real column order.
   *
   * The tag is in every stem, so the content hash is new and the duplicate
   * detector has nothing to match — which is the property that makes this
   * suite repeatable against a database that remembers everything.
   */
  function csv(options: { readonly rows: number; readonly withBadKey: boolean; readonly batch: string }): string {
    const lines = ["type,text,difficulty,options,correct,explanation,topic,expectedSeconds,origin"];
    for (let index = 0; index < options.rows; index += 1) {
      const key = options.withBadKey && index === 1 ? 9 : 1;
      lines.push(
        [
          "single",
          // The batch is in the stem as well as the tag: the duplicate
          // detector hashes the stem, so two files of the same shape must
          // differ in it or the second one imports nothing.
          `"${tag} ${options.batch} question ${index}: what is ${index} plus 1?"`,
          "easy",
          `${index + 1}|${index + 2}|${index + 3}|${index + 4}`,
          String(key),
          `"Adding one to ${index} gives ${index + 1}, which is the first option. A row written by a test."`,
          "PERCENTAGES",
          "30",
          // Named rather than left to the importer, which defaults to
          // FACULTY - see the fence in aptitude-bank.test.ts.
          "ai",
        ].join(","),
      );
    }
    return `${lines.join("\n")}\n`;
  }

  const importCsv = (text: string, batch: string) =>
    runAptitudeImport({
      text,
      fileName: `${batch}.csv`,
      uploadedById: authorId,
      // "upload" or "cli:…" only (`AptitudeImport_via_check`) — the
      // constraint that says this bank arrives through
      // scripts/import-aptitude.ts rather than a test helper.
      via: "cli:aptitude-import-test",
      defaultArea: null,
      defaultTopic: null,
      sourceBatch: batch,
    });

  beforeAll(async () => {
    ({ db } = await import("@/lib/db"));
    ({ runAptitudeImport } = await import("@/lib/aptitude/import"));
    ({ publishAptitudeQuestion } = await import("@/server/actions/super-aptitude"));
    shared = await import("@recx/shared");
    authorId = await staff("author");
    actorId = await staff("reviewer");
  }, 120_000);

  afterAll(async () => {
    if (!ENABLED) return;
    // Everything here is still DRAFT, so it can all go. Nothing in this
    // suite publishes a generated row, for exactly that reason.
    await db.aptitudeQuestion.deleteMany({ where: { sourceBatch: { startsWith: tag } } });
    if (importedIds.length > 0) {
      await db.aptitudeQuestionStat.deleteMany({ where: { questionId: { in: importedIds } } });
      await db.aptitudeQuestion.deleteMany({ where: { id: { in: importedIds } } });
    }
    if (userIds.length > 0) {
      await db.aptitudeImportRow.deleteMany({ where: { import: { uploadedById: { in: userIds } } } });
      await db.aptitudeImport.deleteMany({ where: { uploadedById: { in: userIds } } });
      await db.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
      await db.auditLog.deleteMany({ where: { targetUserId: { in: userIds } } });
      await db.user.deleteMany({ where: { id: { in: userIds } } });
    }
  }, 120_000);

  it("imports a clean file: every row created, as DRAFT, area derived from the topic", async () => {
    const outcome = await importCsv(csv({ rows: 5, withBadKey: false, batch: "clean" }), `${tag}-clean`);

    expect(outcome.status).toBe("DONE");
    expect(outcome.total).toBe(5);
    expect(outcome.created).toBe(5);
    expect(outcome.failed).toBe(0);

    const rows = await db.aptitudeQuestion.findMany({
      where: { sourceBatch: `${tag}-clean` },
      select: { id: true, status: true, origin: true, area: true, explanation: true },
    });
    importedIds.push(...rows.map((row) => row.id));
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((r) => r.status))).toEqual(new Set(["DRAFT"]));
    expect(new Set(rows.map((r) => r.origin))).toEqual(new Set(["AI_ASSISTED"]));
    // No area column was supplied: it came from the topic, which is the one
    // mapping that cannot be wrong.
    expect(new Set(rows.map((r) => r.area))).toEqual(new Set(["QUANTITATIVE"]));
    expect(rows.every((r) => r.explanation.length >= shared.APTITUDE_LIMITS.explanation.min)).toBe(true);
  }, 120_000);

  it("one bad row fails on its own and the rest of the file still imports", async () => {
    // SPEC §5: "so one bad row cannot discard a 300-question file." That
    // sentence, tested.
    const outcome = await importCsv(csv({ rows: 5, withBadKey: true, batch: "mixed" }), `${tag}-mixed`);

    expect(outcome.status).toBe("DONE");
    expect(outcome.total).toBe(5);
    expect(outcome.failed).toBe(1);
    expect(outcome.created).toBe(4);

    const rows = await db.aptitudeQuestion.findMany({
      where: { sourceBatch: `${tag}-mixed` },
      select: { id: true },
    });
    importedIds.push(...rows.map((row) => row.id));
    expect(rows).toHaveLength(4);

    // The reason is on the row, which is where the admin page reads it from.
    const failed = await db.aptitudeImportRow.findMany({
      where: { importId: outcome.importId, status: "FAILED" },
      select: { line: true, errors: true },
    });
    expect(failed).toHaveLength(1);
    expect(JSON.stringify(failed[0]!.errors)).toMatch(/not one of the 4 options/i);
  }, 120_000);

  it("refuses to let the author publish their own question", async () => {
    // The second pair of eyes, and the reason Phase 16k closes only half of
    // §1.2: a worked explanation nobody else has read is one nobody has
    // checked, so the review is a person's and not a script's.
    const mine = await db.aptitudeQuestion.findFirstOrThrow({
      where: { id: { in: importedIds } },
      select: { id: true },
    });
    await db.aptitudeQuestion.update({ where: { id: mine.id }, data: { authorId } });

    const reviewer = actorId;
    actorId = authorId;
    const refused = await publishAptitudeQuestion({ questionId: mine.id });
    actorId = reviewer;

    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toMatch(/second pair of eyes/i);
    // Still a DRAFT, so the teardown can remove it.
    const after = await db.aptitudeQuestion.findUniqueOrThrow({
      where: { id: mine.id },
      select: { status: true },
    });
    expect(after.status).toBe("DRAFT");
    await db.aptitudeQuestion.update({ where: { id: mine.id }, data: { authorId: null } });
  }, 120_000);

  it("re-importing the same content creates nothing", async () => {
    const again = await importCsv(csv({ rows: 5, withBadKey: false, batch: "clean" }), `${tag}-again`);
    expect(again.status).toBe("DONE");
    expect(again.created).toBe(0);
    expect(again.unchanged).toBe(5);
    expect(again.failed).toBe(0);
    // Which is also why the authored bank is imported ONCE per database:
    // the hash is content-based, so a second run of the real files reports
    // UNCHANGED rather than creating a second copy.
  }, 120_000);
});
