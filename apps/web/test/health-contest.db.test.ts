import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { HealthReport } from "@recx/shared";

/**
 * `GET /api/health` reports a live contest, against a real one (Phase 10f).
 *
 * The phase's gated list asks for exactly this: *"activeContest is true
 * during a live contest and false outside it, against a seeded contest."*
 * `apps/web/test/health.test.ts` covers the field with a mocked count, which
 * proves the plumbing and not the predicate — and the predicate is the whole
 * point, because `scripts/ops/deploy.sh` refuses to deploy on the strength of
 * it. A deploy script that trusts a boolean deserves a test that trusts a
 * database.
 *
 * Three windows, written as rows: one open now, one that closed an hour ago,
 * one that opens tomorrow. Only the first may count.
 *
 * Opt-in: RECX_DB_TESTS=1 (RECX_TEST_DATABASE_URL overrides the URL; it must
 * name a *_test database).
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";

vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@localhost:5433/recx_test";
  }
});

/**
 * Redis is faked up: this file is about the contest predicate, and a Redis
 * that happened to be down would make `ok` false without saying anything
 * about `activeContest`.
 */
vi.mock("@/lib/redis", () => ({
  redis: () => ({ status: "ready", ping: async () => "PONG", once: () => undefined, off: () => undefined }),
}));

describe.skipIf(!ENABLED)("/api/health against recx_test", () => {
  const tag = `health-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let db: (typeof import("@/lib/db"))["db"];
  let GET: (typeof import("@/app/api/health/route"))["GET"];
  let actorId = "";
  const created: string[] = [];

  const read = async (): Promise<HealthReport> => (await GET().then((r) => r.json())) as HealthReport;

  async function contest(suffix: string, startsAt: Date, endsAt: Date) {
    const row = await db.contest.create({
      data: {
        slug: `${tag}-${suffix}`,
        title: `${tag} ${suffix}`,
        rules: "Drill fixture.",
        status: "PUBLISHED",
        startsAt,
        endsAt,
        /**
         * No freeze. `Contest_freeze_check` (SPEC §5) allows one only on a
         * contest at least 90 minutes long, and these windows are an hour —
         * the Linux gate refused the fixture, which is the constraint doing
         * its job on a test rather than on a contest.
         */
        freezeMinutes: 0,
        createdById: actorId,
      },
      select: { id: true },
    });
    created.push(row.id);
    return row.id;
  }

  beforeAll(async () => {
    ({ db } = await import("@/lib/db"));
    ({ GET } = await import("@/app/api/health/route"));
    // Its own owner: recx_test is migrated by the gate, not seeded, so a
    // test that expected a seeded admin would pass on a developer's machine
    // and fail in the gate.
    const owner = await db.user.create({
      data: {
        collegeId: `${tag}-owner`,
        email: `${tag}-owner@rec-code.example`,
        handle: `${tag}-owner`,
        firstName: "Drill",
        lastName: "Owner",
        role: "ADMIN",
      },
      select: { id: true },
    });
    actorId = owner.id;
  });

  afterAll(async () => {
    if (created.length > 0) await db.contest.deleteMany({ where: { id: { in: created } } });
    // A student is never hard-deleted; a fixture admin this file created is
    // not a student, and leaving it behind would break the next run's
    // unique collegeId only by luck.
    if (actorId) await db.user.deleteMany({ where: { id: actorId } });
  });

  it("is false with no contest open, and the counts agree", async () => {
    const before = await read();
    // Other fixtures in this database may have left a contest open; the
    // assertion is about this file's own rows, so it reads the baseline
    // rather than assuming zero.
    expect(before.activeContests).toBe(before.activeContest ? before.activeContests : 0);
    expect(before.db).toBe("up");
    expect(before.migrations, "recx_test is migrated by the gate before the suites run").toBe("current");

    const now = Date.now();
    await contest("past", new Date(now - 7_200_000), new Date(now - 3_600_000));
    await contest("future", new Date(now + 3_600_000), new Date(now + 7_200_000));

    const after = await read();
    expect(after.activeContests, "a window that closed and one that has not opened count for nothing").toBe(
      before.activeContests,
    );
    expect(after.activeContest).toBe(before.activeContest);
  });

  it("is true while a window is open, and false again once it closes", async () => {
    const before = await read();
    const now = Date.now();
    // A window that closes in two and a half seconds. The first version of
    // this test created a long contest and then moved its end date, and the
    // database refused: "its window, kind and rated flag are fixed" once a
    // contest is PUBLISHED — a Phase 5 invariant, so that a contest cannot
    // be rescheduled out from under the students sitting it. The clock is
    // the only thing that may end a contest, so the clock is what this test
    // uses.
    await contest("live", new Date(now - 1_000), new Date(now + 2_500));

    const live = await read();
    expect(live.activeContest, "a contest whose window is open right now is live").toBe(true);
    expect(live.activeContests).toBe(before.activeContests + 1);

    /**
     * Live by the CLOCK, not by a status column. That is the property the
     * deploy gate depends on: a contest that over-ran its scheduled end must
     * not keep blocking deploys for ever, and the endpoint must not need a
     * job to have run to tell the truth.
     */
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const ended = await read();
    expect(ended.activeContest).toBe(before.activeContest);
    expect(ended.activeContests).toBe(before.activeContests);
  });

  it("says nothing about WHICH contest, even while one is live", async () => {
    /**
     * The endpoint is unauthenticated. An operator needs to know whether
     * something is running; a stranger must not learn what. So the body is
     * a boolean and a count, and this asserts the slug and title of a live
     * contest appear nowhere in it.
     */
    const now = Date.now();
    await contest("secret", new Date(now - 60_000), new Date(now + 3_600_000));
    const body = JSON.stringify(await read());
    expect(body).not.toContain(tag);
    expect(body).not.toContain("secret");
    expect(Object.keys(JSON.parse(body) as Record<string, unknown>).sort()).toEqual([
      "activeAssessment",
      "activeAssessments",
      "activeContest",
      "activeContests",
      "db",
      "migrations",
      "ok",
      "redis",
      "version",
    ]);
  });
});
