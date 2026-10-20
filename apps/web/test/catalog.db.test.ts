import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CatalogFilters } from "@/components/problems/catalog-filters";

/**
 * Phase 10c put the company filter's options and the problem pointer under
 * `unstable_cache`, and Next's real one throws "incrementalCache missing"
 * outside a request. Here it is the identity, so the reads run and this file
 * keeps testing the SQL rather than the cache — the same mock the exposure
 * sweep uses. (The Linux gate found this: the function is only ever called
 * from a request in production, so nothing on Windows noticed.)
 */
vi.mock("next/cache", () => ({
  unstable_cache: <T>(fn: T) => fn,
  revalidatePath: () => undefined,
  revalidateTag: () => undefined,
}));

/**
 * The /problems catalogue query against a real Postgres (recx_test,
 * migrations applied): only PUBLISHED problems with a live version, title
 * search through the pg_trgm index, every filter (difficulty, topic,
 * curated company, the viewer's UserProblemStatus), the three sorts, 50-row
 * pages with clamping, and per-viewer bookmark / solve columns.
 *
 * Every query includes this run's unique tag as a search word, so rows from
 * other tests sharing the database never interfere.
 *
 * Opt-in: RECX_DB_TESTS=1 (RECX_TEST_DATABASE_URL overrides the URL; it must
 * name a *_test database).
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";
if (ENABLED) {
  process.env.DATABASE_URL =
    process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@localhost:5433/recx_test";
}

type Modules = {
  db: (typeof import("@/lib/db"))["db"];
  queries: typeof import("@/server/queries/problems");
  filters: typeof import("@/components/problems/catalog-filters");
};

describe.skipIf(!ENABLED)("catalogue query against recx_test", () => {
  const tag = `ctlg${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
  const COUNT = 53;
  let m: Modules;
  const userIds: string[] = [];
  const problemIds: string[] = [];
  const companyIds: string[] = [];
  let me = "";
  let other = "";
  let acme = "";
  /** Published problems by index. */
  const p: string[] = [];

  const code = (i: number) => `${tag}-${String(i).padStart(3, "0")}`;
  const difficultyOf = (i: number) => (["EASY", "MEDIUM", "HARD"] as const)[i % 3]!;

  async function list(overrides: Partial<CatalogFilters> & { companyId?: string | null } = {}) {
    const base = m.filters.parseCatalogFilters({ q: tag });
    const { companyId = null, ...rest } = overrides;
    return m.queries.listCatalog(me, { ...base, ...rest, q: rest.q ?? tag, companyId });
  }
  const codes = (rows: { displayCode: string }[]) => rows.map((r) => r.displayCode);

  beforeAll(async () => {
    m = {
      db: (await import("@/lib/db")).db,
      queries: await import("@/server/queries/problems"),
      filters: await import("@/components/problems/catalog-filters"),
    };
    for (const suffix of ["a", "b"]) {
      const id = `${tag}${suffix}`;
      const user = await m.db.user.create({
        data: { collegeId: id, email: `${id}@rec-code.example`, firstName: "Cat", lastName: "Alog", handle: id },
        select: { id: true },
      });
      userIds.push(user.id);
    }
    [me, other] = userIds as [string, string];

    // 53 published problems; every 5th is a "Beta" title, the rest "Alpha".
    await m.db.problem.createMany({
      data: Array.from({ length: COUNT }, (_, i) => ({
        slug: `${tag}-p${i}`,
        displayCode: code(i),
        title: `${tag} ${i % 5 === 0 ? "Beta" : "Alpha"} problem ${i}`,
        difficulty: difficultyOf(i),
        status: "PUBLISHED" as const,
      })),
    });
    // Never listed: a draft, and a "published" row without a live version.
    await m.db.problem.createMany({
      data: [
        { slug: `${tag}-draft`, displayCode: `${tag}-draft`, title: `${tag} Alpha draft`, difficulty: "EASY" },
        {
          slug: `${tag}-nolive`,
          displayCode: `${tag}-nolive`,
          title: `${tag} Alpha no live version`,
          difficulty: "EASY",
          status: "PUBLISHED",
        },
      ],
    });
    const created = await m.db.problem.findMany({
      where: { slug: { startsWith: `${tag}-` } },
      select: { id: true, slug: true },
    });
    for (const row of created) problemIds.push(row.id);
    const bySlug = new Map(created.map((r) => [r.slug, r.id]));
    for (let i = 0; i < COUNT; i++) p.push(bySlug.get(`${tag}-p${i}`)!);

    await m.db.problemVersion.createMany({
      data: p.map((problemId, i) => ({
        problemId,
        revision: 1,
        title: `${tag} problem ${i}`,
        difficulty: difficultyOf(i),
        statementMd: "Test.",
        ioMode: "STDIN" as const,
        timeLimitMs: 1000,
      })),
    });
    await m.db.$executeRaw`
      UPDATE "Problem" pr SET "liveVersionId" = v.id
      FROM "ProblemVersion" v
      WHERE v."problemId" = pr.id AND pr.id = ANY(${p}::text[])`;

    // Topics: 0..9 Graphs; 0..4 also Arrays & Hashing (to check taxonomy order).
    await m.db.problemTag.createMany({
      data: [
        ...p.slice(0, 10).map((problemId) => ({ problemId, topic: "GRAPHS" as const })),
        ...p.slice(0, 5).map((problemId) => ({ problemId, topic: "ARRAYS_HASHING" as const })),
      ],
    });

    // Companies: a curated one on problems 1, 2, 3; an uncurated one on 4.
    const curated = await m.db.company.create({
      data: { slug: `${tag}-acme`, name: `${tag} Acme`, curated: true },
      select: { id: true },
    });
    const uncurated = await m.db.company.create({
      data: { slug: `${tag}-rumour`, name: `${tag} Rumour`, curated: false },
      select: { id: true },
    });
    acme = curated.id;
    companyIds.push(curated.id, uncurated.id);
    await m.db.problemCompanyTag.createMany({
      data: [
        ...[1, 2, 3].map((i) => ({ problemId: p[i]!, companyId: curated.id, frequency: i })),
        { problemId: p[4]!, companyId: uncurated.id },
      ],
    });

    // Acceptance: problems 10 (90%), 11 (20%), 12 (55%); 13 has a stat row with no submissions.
    await m.db.problemStat.createMany({
      data: [
        { problemId: p[10]!, submissions: 10, accepted: 9, attempters: 5, solvers: 4, acceptanceRate: 0.9 },
        { problemId: p[11]!, submissions: 10, accepted: 2, attempters: 5, solvers: 2, acceptanceRate: 0.2 },
        { problemId: p[12]!, submissions: 20, accepted: 11, attempters: 9, solvers: 6, acceptanceRate: 0.55 },
        { problemId: p[13]!, submissions: 0, accepted: 0, acceptanceRate: 0 },
      ],
    });

    // The viewer solved 0 and 1, attempted 2; another student solved 3.
    const now = new Date();
    const status = (userId: string, problemId: string, s: "SOLVED" | "ATTEMPTED") => ({
      userId,
      problemId,
      status: s,
      attempts: 1,
      firstAttemptAt: now,
      lastAttemptAt: now,
      firstAcceptedAt: s === "SOLVED" ? now : null,
    });
    await m.db.userProblemStatus.createMany({
      data: [
        status(me, p[0]!, "SOLVED"),
        status(me, p[1]!, "SOLVED"),
        status(me, p[2]!, "ATTEMPTED"),
        status(other, p[3]!, "SOLVED"),
      ],
    });
    await m.db.bookmark.createMany({ data: [{ userId: me, problemId: p[5]! }, { userId: other, problemId: p[6]! }] });
  }, 120_000);

  afterAll(async () => {
    if (!m) return;
    try {
      await m.db.$transaction([
        m.db.bookmark.deleteMany({ where: { problemId: { in: problemIds } } }),
        m.db.userProblemStatus.deleteMany({ where: { problemId: { in: problemIds } } }),
        m.db.problemStat.deleteMany({ where: { problemId: { in: problemIds } } }),
        m.db.problemCompanyTag.deleteMany({ where: { problemId: { in: problemIds } } }),
        m.db.company.deleteMany({ where: { id: { in: companyIds } } }),
        m.db.problemTag.deleteMany({ where: { problemId: { in: problemIds } } }),
        m.db.problem.updateMany({ where: { id: { in: problemIds } }, data: { liveVersionId: null } }),
        m.db.problemVersion.deleteMany({ where: { problemId: { in: problemIds } } }),
        m.db.problem.deleteMany({ where: { id: { in: problemIds } } }),
        m.db.user.deleteMany({ where: { id: { in: userIds } } }),
      ]);
    } finally {
      await m.db.$disconnect();
    }
  }, 60_000);

  it("lists only published problems with a live version, 50 per page, clamping past the end", async () => {
    const first = await list();
    expect(first.total).toBe(COUNT);
    expect(first.pageCount).toBe(2);
    expect(first.rows).toHaveLength(50);
    expect(first.rows[0]?.displayCode).toBe(code(0));
    expect(codes(first.rows)).not.toContain(`${tag}-draft`);
    expect(codes(first.rows)).not.toContain(`${tag}-nolive`);

    const second = await list({ page: 2 });
    expect(second.rows.map((r) => r.displayCode)).toEqual([code(50), code(51), code(52)]);

    const beyond = await list({ page: 40 });
    expect(beyond.page).toBe(2);
    expect(beyond.rows).toHaveLength(3);
    expect(beyond.total).toBe(COUNT);
  });

  it("searches titles word by word, in any order, case-insensitively", async () => {
    const beta = await list({ q: `BETA ${tag}` });
    expect(beta.total).toBe(11); // 0, 5, 10, …, 50
    expect(beta.rows.every((r) => r.title.includes("Beta"))).toBe(true);
    expect((await list({ q: `${tag} zebra` })).total).toBe(0);
  });

  it("strips LIKE wildcards from the search before they reach the pattern", async () => {
    // "%" and "_" would otherwise match anything / any single character.
    const sanitised = m.filters.parseCatalogFilters({ q: `${tag} %_%` });
    expect(sanitised.q).toBe(tag);
    const result = await m.queries.listCatalog(me, { ...sanitised, companyId: null });
    expect(result.total).toBe(COUNT);
    // Even unsanitised input is matched literally: "_" in place of a letter
    // of the tag is not a single-character wildcard, "%" not a free match.
    expect((await list({ q: `${tag.slice(0, 4)}_${tag.slice(5)}` })).total).toBe(0);
    expect((await list({ q: `${tag.slice(0, 4)}%` })).total).toBe(0);
  });

  it("filters by several difficulties", async () => {
    const hard = await list({ difficulties: ["HARD"] });
    expect(hard.total).toBe(17); // 2, 5, …, 50
    expect(hard.rows.every((r) => r.difficulty === "HARD")).toBe(true);
    const easyOrHard = await list({ difficulties: ["EASY", "HARD"] });
    expect(easyOrHard.total).toBe(18 + 17);
  });

  it("filters by topic and returns topics in taxonomy order", async () => {
    const graphs = await list({ topic: "GRAPHS" });
    expect(graphs.total).toBe(10);
    expect(graphs.rows[0]?.topics).toEqual(["ARRAYS_HASHING", "GRAPHS"]);
    expect(graphs.rows[9]?.topics).toEqual(["GRAPHS"]);
    expect((await list({ topic: "HEAPS" })).total).toBe(0);
    const untagged = (await list({ page: 2 })).rows[0];
    expect(untagged?.topics).toEqual([]);
  });

  it("filters by curated company, and offers only curated companies with published problems", async () => {
    const tagged = await list({ companyId: acme });
    expect(codes(tagged.rows)).toEqual([code(1), code(2), code(3)]);

    const companies = await m.queries.listCatalogCompanies();
    const ours = companies.filter((c) => c.slug.startsWith(tag));
    expect(ours).toEqual([{ id: acme, slug: `${tag}-acme`, name: `${tag} Acme` }]);
  });

  it("filters by the viewer's status from UserProblemStatus only", async () => {
    expect(codes((await list({ status: "solved" })).rows)).toEqual([code(0), code(1)]);
    expect(codes((await list({ status: "attempted" })).rows)).toEqual([code(2)]);
    const notAttempted = await list({ status: "not-attempted" });
    expect(notAttempted.total).toBe(COUNT - 3);
    // Another student's solve of problem 3 is not the viewer's.
    expect(codes(notAttempted.rows)).toContain(code(3));

    const all = await list();
    const byCode = new Map(all.rows.map((r) => [r.displayCode, r]));
    expect(byCode.get(code(0))?.solve).toBe("solved");
    expect(byCode.get(code(2))?.solve).toBe("attempted");
    expect(byCode.get(code(3))?.solve).toBeNull();
  });

  it("combines filters", async () => {
    const combined = await list({ topic: "GRAPHS", difficulties: ["EASY"], status: "solved" });
    expect(codes(combined.rows)).toEqual([code(0)]);
    expect((await list({ topic: "GRAPHS", difficulties: ["MEDIUM"], status: "solved" })).rows.map((r) => r.displayCode)).toEqual([
      code(1),
    ]);
    expect((await list({ companyId: acme, status: "not-attempted" })).rows.map((r) => r.displayCode)).toEqual([code(3)]);
  });

  it("sorts by acceptance with never-submitted problems last, in both directions", async () => {
    const high = await list({ sort: "acceptance" });
    expect(codes(high.rows.slice(0, 3))).toEqual([code(10), code(12), code(11)]);
    const low = await list({ sort: "acceptance-asc" });
    expect(codes(low.rows.slice(0, 3))).toEqual([code(11), code(12), code(10)]);
    // Problems with no stat row, or a stat row with zero submissions (13),
    // follow in code order — the same in both directions.
    const rest = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 13, 14].map(code);
    expect(codes(high.rows.slice(3, 15))).toEqual(rest);
    expect(codes(low.rows.slice(3, 15))).toEqual(rest);
    expect(high.rows[0]).toMatchObject({ submissions: 10, accepted: 9 });
    expect(low.rows.find((r) => r.displayCode === code(13))).toMatchObject({ submissions: 0, accepted: 0 });
  });

  it("sorts by difficulty either way, then by code", async () => {
    const easy = await list({ sort: "difficulty" });
    expect(easy.rows[0]?.difficulty).toBe("EASY");
    expect(codes(easy.rows.slice(0, 2))).toEqual([code(0), code(3)]);
    const hard = await list({ sort: "difficulty-desc" });
    expect(codes(hard.rows.slice(0, 2))).toEqual([code(2), code(5)]);
  });

  it("marks only the viewer's bookmarks", async () => {
    const rows = (await list()).rows;
    expect(rows.filter((r) => r.bookmarked).map((r) => r.displayCode)).toEqual([code(5)]);
  });

  it("the title predicate is servable by the pg_trgm GIN index (incl. escaped and 2-character words)", async () => {
    // A test table is tiny, so the planner would rather filter rows it found
    // through another index; with sequential scans off and only the title
    // predicate, the plan shows which index can answer it.
    for (const patterns of [["%beta%", `%${tag}%`], ["%ab\\_c%"], ["%be%"]]) {
      const plan = await m.db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
        return tx.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(
          `EXPLAIN SELECT p.id FROM "Problem" p WHERE ${patterns.map((_, i) => `p.title ILIKE $${i + 1}`).join(" AND ")}`,
          ...patterns,
        );
      });
      const text = plan.map((r) => r["QUERY PLAN"]).join("\n");
      expect(text).toContain("Problem_title_trgm_idx");
    }
  });
});
