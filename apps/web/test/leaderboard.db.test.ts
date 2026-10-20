import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { publicName } from "@recx/design";
import { db } from "@/lib/db";
import { isStrictlyAhead, parseBoardQuery, type ViewerCohort } from "@/components/leaderboard/model";
import { getLeaderboard, standingSql } from "@/server/queries/leaderboard";

/**
 * The leaderboard queries against a real Postgres (recx_test, migrations
 * applied): rank counting vs. a brute-force reference, opt-out and staff
 * exclusion, the ±2 window, the full board, closed-week snapshots, and that
 * the rank count is served by the cohort index.
 *
 * Opt-in: RECX_DB_TESTS=1 (RECX_TEST_DATABASE_URL overrides the URL; it must
 * name a *_test database). Rows live in a private cohort and a far-future
 * week, so they never meet another test's data, and are removed afterwards.
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";

vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";
  }
});

const NOW = new Date("2099-01-15T06:00:00.000Z"); // ISO week 2099-W03 (Asia/Kolkata)
const WEEK = "2099-W03";
const LAST_WEEK = "2099-W02";
const T0 = Date.parse("2099-01-12T04:00:00.000Z");

interface Seeded {
  id: string;
  firstName: string;
  lastName: string;
  role: "STUDENT" | "ADMIN";
  leaderboardOptOut: boolean;
  xp: number;
  lastXpAt: Date;
}

describe.skipIf(!ENABLED)("leaderboard against recx_test", () => {
  const tag = `lb${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
  const cohort: ViewerCohort = { batchYear: 2099, departmentCode: tag.toUpperCase(), section: "Z" };
  const seeded: Seeded[] = [];
  /** Same week, same batch and department, other sections: realistic selectivity for the planner. */
  const NOISE = 300;
  const noiseIds: string[] = [];

  beforeAll(async () => {
    const url = process.env.DATABASE_URL ?? "";
    expect(url, "DB tests must run against a *_test database").toMatch(/_test(\?|$)/);

    // 30 students (XP descending with an exact tie at 12/13), 3 of them opted
    // out, plus one staff account with XP in the same cohort.
    for (let i = 0; i < 31; i++) {
      const role = i === 30 ? "ADMIN" : "STUDENT";
      const firstName = `Lb${i}`;
      const lastName = `Tester${String.fromCharCode(65 + (i % 26))}`;
      const user = await db.user.create({
        data: {
          collegeId: `${tag}-${i}`,
          email: `${tag}-${i}@rec-code.example`,
          firstName,
          lastName,
          handle: `${tag}-${i}`,
          role,
          batchYear: cohort.batchYear,
          departmentCode: cohort.departmentCode,
          section: cohort.section,
          leaderboardOptOut: i === 4 || i === 15 || i === 22,
          visibility: i % 3 === 0 ? "PRIVATE" : "REC_ONLY",
        },
        select: { id: true },
      });
      const xp = i === 13 ? 1000 - 12 * 25 : i === 30 ? 5000 : 1000 - i * 25;
      const lastXpAt = new Date(i === 13 ? T0 + 12 * 60_000 : T0 + i * 60_000);
      seeded.push({ id: user.id, firstName, lastName, role, leaderboardOptOut: i === 4 || i === 15 || i === 22, xp, lastXpAt });
    }
    await db.xpBucket.createMany({
      data: seeded.flatMap((s) => [
        {
          userId: s.id,
          period: "WEEK" as const,
          periodKey: WEEK,
          xp: s.xp,
          solvedEasy: 2,
          solvedMedium: 1,
          solvedHard: 0,
          batchYear: cohort.batchYear,
          departmentCode: cohort.departmentCode,
          section: cohort.section,
          lastXpAt: s.lastXpAt,
        },
        {
          userId: s.id,
          period: "WEEK" as const,
          periodKey: LAST_WEEK,
          xp: s.xp,
          batchYear: cohort.batchYear,
          departmentCode: cohort.departmentCode,
          section: cohort.section,
          lastXpAt: s.lastXpAt,
        },
      ]),
    });
    await db.user.createMany({
      data: Array.from({ length: NOISE }, (_, i) => ({
        collegeId: `${tag}-n${i}`,
        email: `${tag}-n${i}@rec-code.example`,
        firstName: `Noise${i}`,
        lastName: "Other",
        handle: `${tag}-n${i}`,
        batchYear: cohort.batchYear,
        departmentCode: cohort.departmentCode,
        section: `S${i % 6}`,
      })),
    });
    const noise = await db.user.findMany({ where: { collegeId: { startsWith: `${tag}-n` } }, select: { id: true, section: true } });
    noiseIds.push(...noise.map((n) => n.id));
    await db.xpBucket.createMany({
      data: noise.map((n, i) => ({
        userId: n.id,
        period: "WEEK" as const,
        periodKey: WEEK,
        xp: 2000 - i,
        batchYear: cohort.batchYear,
        departmentCode: cohort.departmentCode,
        section: n.section,
        lastXpAt: new Date(T0),
      })),
    });

    // Last week's frozen top list: reversed order on purpose (the reader re-sorts),
    // and it includes an opted-out student, who must not reappear.
    await db.leaderboardSnapshot.create({
      data: {
        period: "WEEK",
        periodKey: LAST_WEEK,
        scope: "SECTION",
        scopeKey: `${cohort.batchYear}:${cohort.departmentCode}:${cohort.section}`,
        top: seeded
          .filter((s) => s.role === "STUDENT")
          .slice(0, 8)
          .reverse()
          .map((s) => ({ userId: s.id, xp: s.xp + 1, lastXpAt: s.lastXpAt.toISOString(), solved: 3 })),
      },
    });
  });

  afterAll(async () => {
    if (!ENABLED) return;
    const ids = [...seeded.map((s) => s.id), ...noiseIds];
    await db.leaderboardSnapshot.deleteMany({ where: { periodKey: { in: [WEEK, LAST_WEEK] }, scopeKey: { contains: cohort.departmentCode! } } });
    await db.xpBucket.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  });

  const visible = () => seeded.filter((s) => s.role === "STUDENT" && !s.leaderboardOptOut);
  const referenceRank = (s: Seeded) => 1 + visible().filter((o) => o.id !== s.id && isStrictlyAhead(o, s)).length;
  const viewerOf = (s: Seeded) => ({ ...s, ...cohort });
  const query = (params: Record<string, string> = {}) => parseBoardQuery(params, cohort);

  it("ranks every student exactly as the brute-force reference", async () => {
    for (const s of seeded.filter((x) => x.role === "STUDENT")) {
      const view = await getLeaderboard(viewerOf(s), query(), NOW);
      expect(view.periodKey).toBe(WEEK);
      expect(view.standing.kind).toBe("ranked");
      expect(view.standing.rank, `rank of ${s.firstName}`).toBe(referenceRank(s));
      expect(view.standing.total).toBe(visible().length);
      expect(view.standing.hidden).toBe(s.leaderboardOptOut);
    }
  });

  it("shows the top 10 by publicName only, without opted-out students or staff", async () => {
    const view = await getLeaderboard(viewerOf(seeded[0]!), query(), NOW);
    const rows = view.segments.flatMap((seg) => seg.rows);
    const expected = visible()
      .sort((a, b) => b.xp - a.xp || a.lastXpAt.getTime() - b.lastXpAt.getTime())
      .slice(0, 10)
      .map((s) => publicName(s.firstName, s.lastName));
    expect(rows.map((r) => r.name)).toEqual(expected);
    const hiddenNames = seeded.filter((s) => s.leaderboardOptOut || s.role !== "STUDENT").map((s) => publicName(s.firstName, s.lastName));
    for (const r of rows) expect(hiddenNames).not.toContain(r.name);
    // The exact tie (users 12 and 13) shares a rank.
    const tied = rows.filter((r) => r.name === publicName("Lb12", "TesterM") || r.name === publicName("Lb13", "TesterN"));
    expect(new Set(tied.map((r) => r.rank)).size).toBeLessThanOrEqual(1);
  });

  it("pins a lower-ranked viewer's ±2 neighbourhood in a second segment", async () => {
    const viewer = seeded[25]!;
    const view = await getLeaderboard(viewerOf(viewer), query(), NOW);
    expect(view.segments.map((s) => s.label)).toEqual(["top", "around-you"]);
    const around = view.segments[1]!.rows;
    const rank = referenceRank(viewer);
    expect(around.map((r) => r.rank)).toEqual([rank - 2, rank - 1, rank, rank + 1, rank + 2].filter((r) => r <= visible().length));
    expect(around.filter((r) => r.isViewer).map((r) => r.name)).toEqual([publicName(viewer.firstName, viewer.lastName)]);
    expect(view.standing.xpToMoveUp).toBe(26);
  });

  it("keeps an opted-out viewer's rank private and off everyone else's board", async () => {
    const hidden = seeded[15]!;
    const own = await getLeaderboard(viewerOf(hidden), query(), NOW);
    const mine = own.segments.flatMap((s) => s.rows).filter((r) => r.isViewer);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ hiddenFromPeers: true, rank: referenceRank(hidden) });

    const peer = await getLeaderboard(viewerOf(seeded[16]!), query({ view: "full" }), NOW);
    const names = (peer.full ?? []).map((r) => r[1]);
    expect(names).toHaveLength(visible().length);
    expect(names).not.toContain(publicName(hidden.firstName, hidden.lastName));
  });

  it("does not rank staff", async () => {
    const staff = seeded[30]!;
    const view = await getLeaderboard(viewerOf(staff), query(), NOW);
    expect(view.standing.kind).toBe("staff");
    expect(view.segments.flatMap((s) => s.rows).some((r) => r.isViewer)).toBe(false);
  });

  it("reads a closed week from its snapshot, re-applying opt-outs", async () => {
    const view = await getLeaderboard(viewerOf(seeded[0]!), query({ period: "last-week" }), NOW);
    expect(view.source).toBe("snapshot");
    expect(view.periodKey).toBe(LAST_WEEK);
    const top = view.segments[0]!.rows;
    const expected = seeded
      .slice(0, 8)
      .filter((s) => s.role === "STUDENT" && !s.leaderboardOptOut)
      .map((s) => publicName(s.firstName, s.lastName));
    expect(top.map((r) => r.name)).toEqual(expected);
    expect(top.map((r) => r.rank)).toEqual(expected.map((_, i) => i + 1));
  });

  it("counts the rank from the cohort index, not a table scan", async () => {
    const viewer = seeded[20]!;
    const plan = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`ANALYZE "XpBucket"`);
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
      const q = standingSql("WEEK", WEEK, query().filter, viewer.id);
      return tx.$queryRawUnsafe<Array<{ "QUERY PLAN": unknown }>>(`EXPLAIN (FORMAT JSON) ${q.text}`, ...q.values);
    });
    const nodes: Array<Record<string, unknown>> = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === "object") {
        const n = node as Record<string, unknown>;
        if (typeof n["Node Type"] === "string") nodes.push(n);
        Object.values(n).forEach(walk);
      }
    };
    walk(plan.map((p) => p["QUERY PLAN"]));
    const onBuckets = nodes.filter((n) => n["Relation Name"] === "XpBucket");
    expect(onBuckets.length).toBeGreaterThan(0);
    expect(onBuckets.filter((n) => n["Node Type"] === "Seq Scan")).toEqual([]);
    // An Index (Only) Scan names its index itself; a bitmap scan names it on its Bitmap Index Scan child.
    expect(nodes.map((n) => n["Index Name"])).toContain(
      "XpBucket_period_periodKey_batchYear_departmentCode_section__idx",
    );
  });
});
