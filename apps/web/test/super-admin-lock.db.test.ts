import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * "At least one active super-admin always remains", under concurrency,
 * against a real Postgres (recx_test). Every path that can remove a
 * super-admin counts them through countActiveSuperAdminsLocked, which holds
 * an advisory lock until the transaction ends. So a second count waits for
 * the first transaction and sees its change. Without the lock, two
 * super-admins demoting each other both counted two and both committed.
 * Opt-in: RECX_DB_TESTS=1.
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";

const state = vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@localhost:5433/recx_test";
  }
  return { user: null as unknown };
});

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: async () => state.user, destroyAllSessions: async () => undefined }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));
vi.mock("@/lib/ip", () => ({ requestIpHash: async () => null }));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined, auditMany: async () => undefined }));

type M = {
  db: (typeof import("@/lib/db"))["db"];
  lock: typeof import("@/lib/accounts/super-admins");
  roles: typeof import("@/server/actions/super-roles");
  support: typeof import("./support/governance-db");
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!ENABLED)("the last active super-admin, under concurrency (recx_test)", () => {
  const tag = `sal-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let m: M;
  let users: Awaited<ReturnType<M["support"]["createUsers"]>>;

  beforeAll(async () => {
    const support = await import("./support/governance-db");
    support.assertTestDatabase();
    m = {
      db: (await import("@/lib/db")).db,
      lock: await import("@/lib/accounts/super-admins"),
      roles: await import("@/server/actions/super-roles"),
      support,
    };
    users = await support.createUsers(m.db, tag, {
      x: { role: "SUPER_ADMIN" },
      y: { role: "SUPER_ADMIN" },
      z: { role: "SUPER_ADMIN" },
    });
  });

  afterAll(async () => {
    if (!m) return;
    try {
      await m.support.cleanupGovernance(m.db, Object.values(users ?? {}).map((u) => u.id), tag);
    } finally {
      await m.db.$disconnect();
    }
  });

  it("a second count waits for the first transaction and sees its change", async () => {
    const order: string[] = [];
    let firstCount = -1;
    const first = m.db.$transaction(
      async (tx) => {
        firstCount = await m.lock.countActiveSuperAdminsLocked(tx);
        order.push("first counted");
        await sleep(400);
        await tx.user.update({ where: { id: users.z!.id }, data: { role: "ADMIN" } });
        order.push("first committed");
      },
      { timeout: 10_000 },
    );
    await sleep(100);
    const second = m.db.$transaction(
      async (tx) => {
        const n = await m.lock.countActiveSuperAdminsLocked(tx);
        order.push("second counted");
        return n;
      },
      { timeout: 10_000 },
    );
    const [, secondCount] = await Promise.all([first, second]);
    expect(order).toEqual(["first counted", "first committed", "second counted"]);
    expect(secondCount).toBe(firstCount - 1);
  });

  it("two super-admins demoting each other at once: at most one succeeds when they are the last two", async () => {
    const others = await m.db.user.count({
      where: { role: "SUPER_ADMIN", status: "ACTIVE", id: { notIn: [users.x!.id, users.y!.id] } },
    });
    // The rule only bites when x and y are the last two active super-admins.
    if (others > 0) return;
    const as = (key: "x" | "y") => ({ ...users[key]!, status: "ACTIVE" });
    state.user = as("x");
    const a = m.roles.setUserRole({ userId: users.y!.id, role: "ADMIN", reason: `race test ${tag}` });
    state.user = as("y");
    const b = m.roles.setUserRole({ userId: users.x!.id, role: "ADMIN", reason: `race test ${tag}` });
    const results = await Promise.all([a, b]);
    expect(results.filter((r) => r.ok).length).toBeLessThanOrEqual(1);
    const left = await m.db.user.count({ where: { role: "SUPER_ADMIN", status: "ACTIVE" } });
    expect(left).toBeGreaterThanOrEqual(1);
  });
});
