import { describe, expect, expectTypeOf, it } from "vitest";
import {
  FULL_ROW_HIDDEN_SELF,
  FULL_ROW_VIEWER,
  TOP_N,
  availableScopes,
  boardHref,
  composeBoard,
  isStrictlyAhead,
  parseBoardQuery,
  rankFromCounts,
  rankNeighbourhood,
  rankRows,
  scopeLabel,
  snapshotScopeKey,
  toFullBoardRows,
  xpToMoveUp,
  type BoardRow,
  type SourceRow,
} from "@/components/leaderboard/model";
import {
  aheadRowsSql,
  behindRowsSql,
  boardPeriodKey,
  bucketScopeSql,
  isHidden,
  peerProfileHref,
  snapshotTopSchema,
  standingSql,
  topRowsSql,
} from "@/server/queries/leaderboard";

const COHORT = { batchYear: 2027, departmentCode: "CSE", section: "A" };
const SECTION = { scope: "SECTION", batchYear: 2027, departmentCode: "CSE", section: "A" } as const;

const T0 = Date.parse("2026-10-05T00:00:00.000Z");
function row(i: number, xp: number, at = T0 + i * 1000, extra: Partial<SourceRow> = {}): SourceRow {
  return { userId: `u${i}`, xp, lastXpAt: new Date(at), name: `Student ${i}.`, solved: 1, profileHref: null, ...extra };
}

/** Rows 1..n in board order: user i has 1000 - i·10 XP. */
function board(n: number): SourceRow[] {
  return Array.from({ length: n }, (_, k) => row(k + 1, 1000 - (k + 1) * 10));
}

/** Postgres text of a Prisma.Sql ($1, $2 … placeholders), whitespace collapsed. */
const sqlText = (s: { text: string }) => s.text.replace(/\s+/g, " ");

describe("scope and period selection", () => {
  it("defaults to the viewer's SECTION board for this week", () => {
    const q = parseBoardQuery({}, COHORT);
    expect(q.filter).toEqual(SECTION);
    expect(q.period.value).toBe("week");
    expect(q.period.period).toBe("WEEK");
    expect(q.full).toBe(false);
  });

  it("accepts every scope and period the viewer has", () => {
    expect(parseBoardQuery({ scope: "college", period: "all" }, COHORT)).toMatchObject({
      filter: { scope: "COLLEGE" },
      period: { period: "ALL_TIME" },
    });
    expect(parseBoardQuery({ scope: "department", period: "month" }, COHORT).filter).toEqual({
      scope: "DEPARTMENT",
      departmentCode: "CSE",
    });
    expect(parseBoardQuery({ scope: "batch", period: "last-week", view: "full" }, COHORT)).toMatchObject({
      filter: { scope: "BATCH", batchYear: 2027 },
      period: { period: "WEEK", previous: true },
      full: true,
    });
  });

  it("ignores junk and repeated params, falling back to the defaults", () => {
    const q = parseBoardQuery({ scope: ["nonsense", "college"], period: "decade", view: "everything" }, COHORT);
    expect(q.filter).toEqual(SECTION);
    expect(q.period.value).toBe("week");
    expect(q.full).toBe(false);
    expect(parseBoardQuery({ scope: ["college", "section"] }, COHORT).filter).toEqual({ scope: "COLLEGE" });
  });

  it("never offers a scope the viewer has no cohort for (staff see the college board only)", () => {
    const staff = { batchYear: null, departmentCode: null, section: null };
    expect(availableScopes(staff)).toEqual([{ scope: "COLLEGE" }]);
    expect(parseBoardQuery({ scope: "section" }, staff).filter).toEqual({ scope: "COLLEGE" });
    expect(availableScopes({ batchYear: 2027, departmentCode: null, section: "A" }).map((f) => f.scope)).toEqual([
      "BATCH",
      "COLLEGE",
    ]);
  });

  it("names snapshot scope keys as the schema documents", () => {
    expect(snapshotScopeKey({ scope: "COLLEGE" })).toBe("");
    expect(snapshotScopeKey({ scope: "DEPARTMENT", departmentCode: "CSE" })).toBe("CSE");
    expect(snapshotScopeKey({ scope: "BATCH", batchYear: 2027 })).toBe("2027");
    expect(snapshotScopeKey(SECTION)).toBe("2027:CSE:A");
  });

  it("labels the viewer's own section and builds stable links", () => {
    expect(scopeLabel(SECTION)).toEqual({ title: "Section", detail: "CSE A, 2027" });
    expect(boardHref(SECTION, "month")).toBe("/leaderboard?scope=section&period=month");
    expect(boardHref({ scope: "COLLEGE" }, "all", true)).toBe("/leaderboard?scope=college&period=all&view=full");
  });

  it("reads last week's bucket key for the 'Last week' option", () => {
    const now = new Date("2026-10-10T06:00:00Z"); // Saturday, ISO week 41
    expect(boardPeriodKey(parseBoardQuery({ period: "week" }, COHORT), now)).toBe("2026-W41");
    expect(boardPeriodKey(parseBoardQuery({ period: "last-week" }, COHORT), now)).toBe("2026-W40");
    expect(boardPeriodKey(parseBoardQuery({ period: "month" }, COHORT), now)).toBe("2026-10");
    expect(boardPeriodKey(parseBoardQuery({ period: "all" }, COHORT), now)).toBe("all");
  });
});

describe("tie-break and rank counting", () => {
  it("ranks more XP first, then whoever reached it first", () => {
    const a = { xp: 100, lastXpAt: new Date(T0) };
    expect(isStrictlyAhead({ xp: 101, lastXpAt: new Date(T0 + 9e6) }, a)).toBe(true);
    expect(isStrictlyAhead({ xp: 100, lastXpAt: new Date(T0 - 1) }, a)).toBe(true);
    expect(isStrictlyAhead({ xp: 100, lastXpAt: new Date(T0) }, a)).toBe(false);
    expect(isStrictlyAhead({ xp: 99, lastXpAt: new Date(T0 - 9e6) }, a)).toBe(false);
  });

  it("my rank = 1 + rows strictly ahead − hidden rows among them", () => {
    expect(rankFromCounts(0, 0)).toBe(1);
    expect(rankFromCounts(13, 0)).toBe(14);
    expect(rankFromCounts(13, 3)).toBe(11);
    expect(rankFromCounts(2, 5)).toBe(1);
  });

  it("agrees with a brute-force count over a shuffled board", () => {
    const rows = Array.from({ length: 60 }, (_, i) => row(i, (i * 37) % 23, T0 + ((i * 11) % 7) * 1000));
    const sorted = [...rows].sort((p, q) => q.xp - p.xp || p.lastXpAt.getTime() - q.lastXpAt.getTime());
    const ranked = rankRows(sorted, 1);
    for (const r of ranked) {
      const ahead = rows.filter((o) => isStrictlyAhead(o, r)).length;
      expect(r.rank).toBe(rankFromCounts(ahead, 0));
    }
  });

  it("uses competition ranking for exact ties", () => {
    const tied = [row(1, 50, T0), row(2, 40, T0 + 5), row(3, 40, T0 + 5), row(4, 30, T0)];
    expect(rankRows(tied, 1).map((r) => r.rank)).toEqual([1, 2, 2, 4]);
    expect(rankRows(tied, 21).map((r) => r.rank)).toEqual([21, 22, 22, 24]);
  });

  it("computes the XP needed to move up a place", () => {
    expect(xpToMoveUp({ xp: 340, lastXpAt: new Date(T0) }, { xp: 400, lastXpAt: new Date(T0) })).toBe(61);
    expect(xpToMoveUp({ xp: 400, lastXpAt: new Date(T0 + 1) }, { xp: 400, lastXpAt: new Date(T0) })).toBe(1);
    expect(xpToMoveUp({ xp: 400, lastXpAt: new Date(T0) }, null)).toBeNull();
  });
});

describe("neighbourhood windowing", () => {
  const all = board(40);

  function windowFor(index: number, hidden = false) {
    const viewer = all[index]!;
    const visible = hidden ? all.filter((r) => r !== viewer) : all;
    const rank = 1 + visible.filter((r) => isStrictlyAhead(r, viewer)).length;
    return rankNeighbourhood({
      ahead: visible.filter((r) => isStrictlyAhead(r, viewer)).slice(-2),
      viewer,
      viewerHidden: hidden,
      behind: visible.filter((r) => r !== viewer && !isStrictlyAhead(r, viewer)).slice(0, 2),
      viewerRank: rank,
    });
  }

  it("is the viewer ±2 with exact ranks", () => {
    const { rows, viewerRow } = windowFor(24); // rank 25
    expect(rows.map((r) => [r.userId, r.rank])).toEqual([
      ["u23", 23],
      ["u24", 24],
      ["u25", 25],
      ["u26", 26],
      ["u27", 27],
    ]);
    expect(viewerRow).toMatchObject({ userId: "u25", rank: 25 });
  });

  it("shrinks at the edges of the board", () => {
    expect(windowFor(0).rows.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(windowFor(39).rows.map((r) => r.rank)).toEqual([38, 39, 40]);
  });

  it("does not give a hidden (opted-out) viewer a public position", () => {
    const { rows, viewerRow } = windowFor(24, true);
    expect(rows.map((r) => [r.userId, r.rank])).toEqual([
      ["u23", 23],
      ["u24", 24],
      ["u26", 25],
      ["u27", 26],
    ]);
    expect(viewerRow).toMatchObject({ userId: "u25", rank: 25 });
  });

  it("gives an exact tie with the viewer the viewer's rank", () => {
    const viewer = row(5, 500, T0);
    const twin = row(6, 500, T0);
    const { rows } = rankNeighbourhood({
      ahead: [row(3, 700), row(4, 600)],
      viewer,
      viewerHidden: false,
      behind: [twin, row(7, 400)],
      viewerRank: 9,
    });
    expect(rows.map((r) => r.rank)).toEqual([7, 8, 9, 9, 11]);
  });
});

describe("composing top 10 + the viewer's neighbourhood", () => {
  const all = board(40);
  const ranked = rankRows(all, 1);
  const top = ranked.slice(0, TOP_N);

  function compose(viewerIndex: number | null, hidden = false) {
    if (viewerIndex === null) {
      return composeBoard({ top, neighbourhood: [], viewerRow: null, viewerId: "nobody", viewerHidden: false });
    }
    const viewer = all[viewerIndex]!;
    const visible = hidden ? all.filter((r) => r !== viewer) : all;
    const rank = 1 + visible.filter((r) => isStrictlyAhead(r, viewer)).length;
    const { rows, viewerRow } = rankNeighbourhood({
      ahead: visible.filter((r) => isStrictlyAhead(r, viewer)).slice(-2),
      viewer,
      viewerHidden: hidden,
      behind: visible.filter((r) => r !== viewer && !isStrictlyAhead(r, viewer)).slice(0, 2),
      viewerRank: rank,
    });
    const visibleTop = rankRows(visible, 1).slice(0, TOP_N);
    return composeBoard({ top: visibleTop, neighbourhood: rows, viewerRow, viewerId: viewer.userId, viewerHidden: hidden });
  }

  it("is one segment when the viewer is in (or next to) the top 10", () => {
    const segments = compose(3);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.rows.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(segments[0]!.rows.filter((r) => r.isViewer).map((r) => r.rank)).toEqual([4]);

    const near = compose(11); // rank 12: window 10..14 touches the top 10
    expect(near).toHaveLength(1);
    expect(near[0]!.rows.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  });

  it("pins the viewer's ±2 as a second segment further down", () => {
    const segments = compose(29); // rank 30
    expect(segments.map((s) => s.label)).toEqual(["top", "around-you"]);
    expect(segments[0]!.rows.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(segments[1]!.rows.map((r) => r.rank)).toEqual([28, 29, 30, 31, 32]);
    const you = segments[1]!.rows.filter((r) => r.isViewer);
    expect(you).toHaveLength(1);
    expect(you[0]).toMatchObject({ rank: 30, hiddenFromPeers: false });
  });

  it("shows an opted-out viewer their private row without displacing anyone", () => {
    const segments = compose(29, true);
    const around = segments[1]!.rows;
    expect(around.map((r) => [r.rank, r.isViewer, r.hiddenFromPeers])).toEqual([
      [28, false, false],
      [29, false, false],
      [30, true, true],
      [30, false, false],
      [31, false, false],
    ]);
    // Inside the top 10 too.
    const inTop = compose(2, true)[0]!.rows;
    expect(inTop.filter((r) => r.hiddenFromPeers).map((r) => r.rank)).toEqual([3]);
    expect(inTop.filter((r) => !r.hiddenFromPeers).map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("is just the top 10 for an unranked viewer, and nothing for an empty board", () => {
    const segments = compose(null);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.rows).toHaveLength(10);
    expect(composeBoard({ top: [], neighbourhood: [], viewerRow: null, viewerId: "x", viewerHidden: false })).toEqual([]);
  });

  it("never carries an id, email, roll number, department or section in a board row", () => {
    type Forbidden = Extract<keyof BoardRow, "userId" | "email" | "collegeId" | "departmentCode" | "section" | "batchYear">;
    expectTypeOf<Forbidden>().toEqualTypeOf<never>();
    const rows = compose(29).flatMap((s) => s.rows);
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(["hiddenFromPeers", "isViewer", "name", "profileHref", "rank", "solved", "xp"]);
    }
  });
});

describe("the virtualised full board", () => {
  it("flags the viewer and slots a hidden viewer's private row at their rank", () => {
    const ranked = rankRows(board(5), 1);
    expect(toFullBoardRows(ranked, "u3", null).map((r) => [r[0], r[5]])).toEqual([
      [1, 0],
      [2, 0],
      [3, FULL_ROW_VIEWER],
      [4, 0],
      [5, 0],
    ]);
    const me = { ...row(9, 975), rank: 2 };
    const withHidden = toFullBoardRows(ranked, "u9", me);
    expect(withHidden.map((r) => [r[0], r[5]])).toEqual([
      [1, 0],
      [2, FULL_ROW_VIEWER | FULL_ROW_HIDDEN_SELF],
      [2, 0],
      [3, 0],
      [4, 0],
      [5, 0],
    ]);
    // Tuples hold display data only.
    expect(withHidden[0]).toHaveLength(6);
  });
});

describe("leaderboard SQL reads XpBucket by the ordered index", () => {
  const me = { userId: "viewer", xp: 340, lastXpAt: new Date(T0) };

  it("scopes each board by its cohort columns", () => {
    expect(sqlText(bucketScopeSql("WEEK", "2026-W41", { scope: "COLLEGE" }))).not.toMatch(/batchYear|departmentCode|section/);
    expect(sqlText(bucketScopeSql("WEEK", "2026-W41", { scope: "DEPARTMENT", departmentCode: "CSE" }))).toContain(
      'b."departmentCode" = ',
    );
    const section = bucketScopeSql("MONTH", "2026-10", SECTION);
    expect(sqlText(section)).toMatch(/b\."batchYear" = \$\d+::int AND b\."departmentCode" = \$\d+ AND b\."section" = \$\d+/);
    expect(section.values).toEqual(["MONTH", "2026-10", 2027, "CSE", "A"]);
  });

  it("counts my rank with the tie-break predicate, never reading rows", () => {
    const sql = sqlText(standingSql("WEEK", "2026-W41", SECTION, "viewer"));
    expect(sql).toContain('(b."xp" > me."xp" OR (b."xp" = me."xp" AND b."lastXpAt" < me."lastXpAt"))');
    expect(sql).toMatch(/SELECT count\(\*\) FROM "XpBucket" b, me WHERE/);
    expect(sql).toContain('u."leaderboardOptOut"');
    expect(sql).not.toMatch(/XpEvent/i);
    expect(sql).not.toMatch(/\bSUM\s*\(/i);
    expect(sql).not.toMatch(/ORDER BY|OFFSET/);
  });

  it("reads the top N in board order and excludes hidden rows", () => {
    const q = topRowsSql("ALL_TIME", "all", { scope: "COLLEGE" }, 10);
    const sql = sqlText(q);
    expect(sql).toContain('ORDER BY b."xp" DESC, b."lastXpAt" ASC, b."userId" ASC LIMIT $');
    expect(sql).toContain('AND NOT (u."leaderboardOptOut" OR u."role" <>');
    expect(q.values.at(-1)).toBe(10);
    expect(sql).not.toMatch(/"email"|"collegeId"|"departmentCode"|"section"/);
  });

  it("windows ±2 by keyset from my (xp, lastXpAt)", () => {
    const ahead = sqlText(aheadRowsSql("WEEK", "2026-W41", SECTION, me, 2));
    expect(ahead).toContain('b."xp" >= $');
    expect(ahead).toContain('ORDER BY b."xp" ASC, b."lastXpAt" DESC, b."userId" DESC LIMIT $');
    const behind = behindRowsSql("WEEK", "2026-W41", SECTION, me, 2);
    expect(sqlText(behind)).toContain('b."userId" <> $');
    expect(sqlText(behind)).toContain('ORDER BY b."xp" DESC, b."lastXpAt" ASC, b."userId" ASC LIMIT $');
    expect(behind.values).toContain("viewer");
  });
});

describe("peer visibility on the board", () => {
  it("hides opted-out students and staff from peers", () => {
    expect(isHidden({ leaderboardOptOut: false, role: "STUDENT" })).toBe(false);
    expect(isHidden({ leaderboardOptOut: true, role: "STUDENT" })).toBe(true);
    expect(isHidden({ leaderboardOptOut: false, role: "ADMIN" })).toBe(true);
  });

  it("links a peer's name only when their profile is visible to signed-in students", () => {
    expect(peerProfileHref("PUBLIC", "priya-s")).toBe("/u/priya-s");
    expect(peerProfileHref("REC_ONLY", "priya-s")).toBe("/u/priya-s");
    expect(peerProfileHref("PRIVATE", "priya-s")).toBeNull();
  });

  it("parses snapshot top lists and refuses malformed ones", () => {
    expect(
      snapshotTopSchema.parse([{ userId: "a", xp: 10, lastXpAt: "2026-10-05T10:00:00.000Z", rank: 1 }])[0]?.lastXpAt,
    ).toBeInstanceOf(Date);
    expect(snapshotTopSchema.safeParse([{ xp: 10 }]).success).toBe(false);
    expect(snapshotTopSchema.safeParse({ top: [] }).success).toBe(false);
  });
});
