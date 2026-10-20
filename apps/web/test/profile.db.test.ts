import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { User } from "@recx/db";
import { db } from "@/lib/db";
import { MIN_COHORT_FOR_MEDIAN, findPublicProfile, getOwnProfile } from "@/server/queries/profile";

/**
 * Profile reads against a real Postgres (recx_test): the /u/[handle]
 * visibility rules through the real lookup, that the public profile carries
 * no private field, the cohort-median time-to-solve, and the own-profile
 * aggregates from UserStats / ActivityDay / UserBadge.
 *
 * Opt-in: RECX_DB_TESTS=1 (RECX_TEST_DATABASE_URL overrides the URL; it must
 * name a *_test database). Every row is tagged and removed afterwards.
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";

vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";
  }
});

const NOW = new Date("2026-10-10T06:00:00.000Z");

describe.skipIf(!ENABLED)("profile reads against recx_test", () => {
  const tag = `pf${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
  const users: Record<string, User> = {};
  const problemIds: string[] = [];
  let badgeId = "";

  async function makeUser(name: string, data: Partial<Pick<User, "visibility" | "status">> = {}) {
    users[name] = await db.user.create({
      data: {
        collegeId: `R${tag}${name}`.toUpperCase(),
        email: `${tag}-${name}@rec-code.example`,
        firstName: `Pf${name}`,
        lastName: "Privatesurname",
        handle: `${tag}-${name}`,
        batchYear: 2027,
        departmentCode: "CSE",
        section: "A",
        bio: `Bio of ${name}`,
        ...data,
      },
    });
    return users[name]!;
  }

  beforeAll(async () => {
    expect(process.env.DATABASE_URL ?? "", "DB tests must run against a *_test database").toMatch(/_test(\?|$)/);
    await makeUser("public", { visibility: "PUBLIC" });
    await makeUser("rec", { visibility: "REC_ONLY" });
    await makeUser("private", { visibility: "PRIVATE" });
    await makeUser("disabled", { visibility: "PUBLIC", status: "DISABLED" });
    for (let i = 0; i < 6; i++) await makeUser(`solver${i}`);

    // Two problems: A solved by 7 (median shown), B solved by 2 (median withheld).
    for (const code of ["A", "B"]) {
      const p = await db.problem.create({
        data: { slug: `${tag}-${code}`, displayCode: `${tag}-${code}`, title: `Profile test ${code}`, difficulty: "MEDIUM", status: "PUBLISHED" },
        select: { id: true },
      });
      problemIds.push(p.id);
    }
    const solve = (userId: string, problemId: string, seconds: number, at: number) =>
      db.userProblemStatus.create({
        data: {
          userId,
          problemId,
          status: "SOLVED",
          attempts: 1,
          firstAttemptAt: new Date(NOW.getTime() - at),
          lastAttemptAt: new Date(NOW.getTime() - at),
          firstAcceptedAt: new Date(NOW.getTime() - at),
          activeSecondsToSolve: seconds,
          solvedLanguage: "cpp20",
        },
      });
    const me = users.public!;
    await solve(me.id, problemIds[0]!, 600, 1000);
    await solve(me.id, problemIds[1]!, 300, 500);
    for (let i = 0; i < 6; i++) await solve(users[`solver${i}`]!.id, problemIds[0]!, (i + 1) * 300, 2000);
    await solve(users.solver0!.id, problemIds[1]!, 100, 2000);

    await db.userStats.create({
      data: {
        userId: me.id,
        solvedMedium: 2,
        solvedTotal: 2,
        assistedSolves: 1,
        currentStreak: 3,
        longestStreak: 5,
        lastActiveDate: new Date("2026-10-09T00:00:00.000Z"),
        xpTotal: 240,
        languageCounts: { cpp20: 2 },
        topicSolved: { GRAPHS: 1 },
        topicAssisted: { TREES: 1 },
      },
    });
    await db.activityDay.createMany({
      data: [
        { userId: me.id, date: new Date("2026-10-09T00:00:00.000Z"), submissions: 3, solved: 1 },
        { userId: me.id, date: new Date("2026-10-10T00:00:00.000Z"), submissions: 1, solved: 1 },
        { userId: me.id, date: new Date("2025-09-01T00:00:00.000Z"), submissions: 9, solved: 9 }, // outside 365 days
      ],
    });
    const badge = await db.badge.create({
      data: { key: `${tag}-first`, name: "First solve", description: "Solve a problem.", icon: "flame", sortOrder: -1 },
    });
    badgeId = badge.id;
    await db.userBadge.create({ data: { userId: me.id, badgeId } });
  });

  afterAll(async () => {
    if (!ENABLED) return;
    const ids = Object.values(users).map((u) => u.id);
    await db.userBadge.deleteMany({ where: { userId: { in: ids } } });
    if (badgeId) await db.badge.deleteMany({ where: { id: badgeId } });
    await db.activityDay.deleteMany({ where: { userId: { in: ids } } });
    await db.userStats.deleteMany({ where: { userId: { in: ids } } });
    await db.userProblemStatus.deleteMany({ where: { userId: { in: ids } } });
    await db.problem.deleteMany({ where: { id: { in: problemIds } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  });

  const handle = (name: string) => users[name]!.handle;
  const peer = () => users.solver1!.id;

  it("applies the visibility rules through the real lookup (404 = null)", async () => {
    expect(await findPublicProfile(handle("public"), null)).not.toBeNull();
    expect(await findPublicProfile(handle("public"), peer())).not.toBeNull();
    expect(await findPublicProfile(handle("rec"), null)).toBeNull();
    expect(await findPublicProfile(handle("rec"), peer())).not.toBeNull();
    expect(await findPublicProfile(handle("private"), peer())).toBeNull();
    expect(await findPublicProfile(handle("private"), users.private!.id)).toMatchObject({ isOwner: true });
    expect(await findPublicProfile(handle("disabled"), peer())).toBeNull();
    expect(await findPublicProfile(`${tag}-nobody`, peer())).toBeNull();
    expect(await findPublicProfile("../etc", peer())).toBeNull();
    expect(await findPublicProfile(encodeURIComponent(handle("public")), null)).not.toBeNull();
  });

  it("exposes only the public fields, under publicName", async () => {
    const profile = (await findPublicProfile(handle("public"), null))!;
    expect(Object.keys(profile).sort()).toEqual(
      ["activity", "avatar", "badges", "bio", "handle", "isOwner", "name", "solved", "today", "topics", "visibility"].sort(),
    );
    expect(profile.name).toBe("Pfpublic P.");
    expect(profile.avatar).toEqual({ firstName: "P", lastName: "P" });
    const json = JSON.stringify(profile);
    for (const secret of [users.public!.email, users.public!.collegeId, "Privatesurname", "CSE", "2027"]) {
      expect(json).not.toContain(secret);
    }
    expect(profile.topics.every((t) => t.assisted === 0)).toBe(true);
    expect(profile.badges.map((b) => b.name)).toEqual(["First solve"]);
    expect(profile.solved.total).toBe(2);
  });

  it("builds the own profile from UserStats, ActivityDay and UserProblemStatus", async () => {
    const own = await getOwnProfile(users.public!, NOW);
    expect(own.streak).toEqual({ current: 3, longest: 5 });
    expect(own.assisted).toEqual({ assisted: 1, unassisted: 1 });
    expect(own.languages).toEqual([{ key: "cpp20", label: "C++20", count: 2 }]);
    expect(own.level.level).toBeGreaterThan(1);
    expect(own.activity.map((a) => a.date)).toEqual(["2026-10-09", "2026-10-10"]);
    expect(own.topics.find((t) => t.topic === "GRAPHS")?.unassisted).toBe(1);
    expect(own.badges.find((b) => b.name === "First solve")?.awardedAt).toBeInstanceOf(Date);
  });

  it("compares time to solve with the cohort median only when the cohort is large enough", async () => {
    const own = await getOwnProfile(users.public!, NOW);
    const [b, a] = own.timeToSolve; // most recent first: B was solved after A
    expect(a).toMatchObject({ title: "Profile test A", yourSeconds: 600, solvers: 7 });
    expect(MIN_COHORT_FOR_MEDIAN).toBeLessThanOrEqual(7);
    // Median of 300, 600, 600, 900, 1200, 1500, 1800 → 900 seconds.
    expect(a!.medianSeconds).toBe(900);
    expect(b).toMatchObject({ title: "Profile test B", yourSeconds: 300, solvers: 2, medianSeconds: null });
  });
});
