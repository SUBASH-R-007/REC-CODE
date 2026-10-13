import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Accommodations against a real Postgres (recx_test), through the server
 * actions: an ADMIN requests, only a SUPER_ADMIN decides; one open request
 * and one approved accommodation per student; granted terms cannot be edited
 * or deleted (trigger); the CHECKs hold the bounds; a change of terms is a
 * superseding request whose approval retires the old grant in the same
 * transaction; withdraw, reject and revoke follow the state machine; the
 * audit metadata never carries the kinds, the reason or the decision note;
 * an out-of-scope student is not found.
 *
 * Opt-in: RECX_DB_TESTS=1 (RECX_TEST_DATABASE_URL overrides the URL).
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";

const state = vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@localhost:5433/recx_test";
  }
  return { user: null as unknown, audits: [] as Array<Record<string, unknown>> };
});

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: async () => state.user, destroyAllSessions: async () => undefined }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));
vi.mock("@/lib/ip", () => ({ requestIpHash: async () => null }));
vi.mock("@/lib/audit", () => ({
  audit: async (entry: Record<string, unknown>) => {
    state.audits.push(entry);
  },
}));

type M = {
  db: (typeof import("@/lib/db"))["db"];
  actions: typeof import("@/server/actions/admin-accommodations");
  support: typeof import("./support/admin-db");
};

const letters = (n: number) => Array.from(randomBytes(n), (b) => String.fromCharCode(65 + (b % 26))).join("");
const DAY = 86_400_000;
const REASON = "Uses a screen reader for all coursework (office letter on file).";

describe.skipIf(!ENABLED)("accommodations against recx_test", () => {
  const tag = `ac${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
  const deptA = `T${letters(5)}`;
  const deptB = `U${letters(5)}`;
  let m: M;
  let u: Record<"sup" | "admin" | "admin2" | "st" | "other" | "third", import("./support/admin-db").TestUser>;

  const as = async (key: keyof typeof u) => {
    state.user = await m.db.user.findUniqueOrThrow({ where: { id: u[key].id } });
  };
  const terms = (fields: Record<string, unknown> = {}) => ({
    kinds: ["SCREEN_READER" as const],
    exemptSignals: ["FOCUS_LOSS" as const, "FULLSCREEN_EXIT" as const],
    extraTimePercent: 0,
    extraTimeMinutes: 0,
    allowBreaks: false,
    breakMinutes: 0,
    fontScalePercent: 100,
    allowScribe: false,
    highContrast: false,
    validUntil: new Date(Date.now() + 90 * DAY),
    ...fields,
  });
  const row = (id: string) => m.db.accommodation.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    m = {
      db: (await import("@/lib/db")).db,
      actions: await import("@/server/actions/admin-accommodations"),
      support: await import("./support/admin-db"),
    };
    u = await m.support.createUsers(m.db, tag, {
      sup: { role: "SUPER_ADMIN" },
      admin: { role: "ADMIN" },
      admin2: { role: "ADMIN" },
      st: { batchYear: 2027, departmentCode: deptA, section: "A" },
      other: { batchYear: 2027, departmentCode: deptB, section: "A" },
      third: { batchYear: 2027, departmentCode: deptA, section: "A" },
    });
    await m.support.grantScope(m.db, u.admin.id, u.sup.id, { departmentCode: deptA, batchYear: null });
    await m.support.grantScope(m.db, u.admin2.id, u.sup.id, { departmentCode: deptA, batchYear: null });
  }, 60_000);

  afterAll(async () => {
    if (!m) return;
    try {
      await m.support.cleanupAdminRows(m.db, Object.values(u ?? {}).map((x) => x.id));
      expect(await m.support.disabledTriggers(m.db)).toEqual([]);
    } finally {
      await m.db.$disconnect();
    }
  }, 60_000);

  let first = "";

  it("an ADMIN requests; a second open request for the same student is refused", async () => {
    await as("admin");
    const result = await m.actions.requestAccommodation({ userId: u.st.id, terms: terms(), reason: REASON });
    expect(result).toMatchObject({ ok: true, data: { status: "REQUESTED" } });
    first = result.ok ? result.data.id : "";
    expect(await row(first)).toMatchObject({ status: "REQUESTED", requestedById: u.admin.id, grantedAt: null, approvedBySuperAdminId: null });

    const again = await m.actions.requestAccommodation({ userId: u.st.id, terms: terms(), reason: REASON });
    expect(again.ok || again.error).toMatch(/already has an open request/);
  });

  it("an ADMIN cannot approve, reject or revoke", async () => {
    await as("admin");
    const forbidden = { ok: false, error: "You don't have permission to do that." };
    expect(await m.actions.approveAccommodation({ id: first })).toEqual(forbidden);
    expect(await m.actions.rejectAccommodation({ id: first, note: "Not now please." })).toEqual(forbidden);
    expect(await m.actions.revokeAccommodation({ id: first, reason: "Not now please." })).toEqual(forbidden);
    expect((await row(first)).status).toBe("REQUESTED");
  });

  it("a SUPER_ADMIN approves; the audit carries no kinds, reason or note", async () => {
    await as("sup");
    state.audits.length = 0;
    expect(await m.actions.approveAccommodation({ id: first, note: "Letter from the accessibility office." })).toEqual({
      ok: true,
      data: { id: first },
    });
    expect(await row(first)).toMatchObject({
      status: "APPROVED",
      approvedBySuperAdminId: u.sup.id,
      decidedById: u.sup.id,
      decisionNote: "Letter from the accessibility office.",
    });
    const entry = state.audits.find((a) => a.action === "accommodation.approved")!;
    expect(entry).toMatchObject({ sensitivity: "SENSITIVE", targetUserId: u.st.id });
    const text = JSON.stringify(entry.metadata);
    expect(text).not.toMatch(/SCREEN_READER|kinds|screen reader|accessibility office|decisionNote|"reason"/);
  });

  it("granted terms cannot be edited or deleted (trigger), and the CHECKs hold the bounds", async () => {
    await expect(m.db.accommodation.update({ where: { id: first }, data: { extraTimePercent: 50 } })).rejects.toThrow();
    await expect(m.db.accommodation.delete({ where: { id: first } })).rejects.toThrow();
    await expect(
      m.db.accommodation.create({
        data: { userId: u.third.id, kinds: ["EXTRA_TIME"], extraTimePercent: 101, reason: "x", validUntil: new Date(Date.now() + DAY), requestedById: u.admin.id },
      }),
    ).rejects.toThrow();
    await expect(
      m.db.accommodation.create({
        data: { userId: u.third.id, kinds: [], reason: "x", validUntil: new Date(Date.now() + DAY), requestedById: u.admin.id },
      }),
    ).rejects.toThrow();
  });

  it("a plain request is refused while an approved one exists; a change supersedes it atomically", async () => {
    await as("admin");
    const plain = await m.actions.requestAccommodation({ userId: u.st.id, terms: terms(), reason: REASON });
    expect(plain.ok || plain.error).toMatch(/already has an approved accommodation/);

    const change = await m.actions.requestAccommodation({
      userId: u.st.id,
      supersedesId: first,
      terms: terms({ kinds: ["SCREEN_READER", "EXTRA_TIME"], extraTimePercent: 33 }),
      reason: REASON,
    });
    expect(change).toMatchObject({ ok: true, data: { status: "REQUESTED" } });
    const second = change.ok ? change.data.id : "";
    expect((await row(first)).status).toBe("APPROVED");

    await as("sup");
    expect(await m.actions.approveAccommodation({ id: second })).toEqual({ ok: true, data: { id: second } });
    expect((await row(first)).status).toBe("SUPERSEDED");
    expect(await row(second)).toMatchObject({ status: "APPROVED", supersedesId: first, extraTimePercent: 33 });
    expect(await m.db.accommodation.count({ where: { userId: u.st.id, status: "APPROVED" } })).toBe(1);

    // Revoke: APPROVED → REVOKED, the reason only in the audit row.
    state.audits.length = 0;
    expect(await m.actions.revokeAccommodation({ id: second, reason: "Granted for the wrong term." })).toEqual({
      ok: true,
      data: { id: second },
    });
    expect(await row(second)).toMatchObject({ status: "REVOKED", revokedById: u.sup.id });
    expect(state.audits[0]).toMatchObject({
      action: "accommodation.revoked",
      metadata: expect.objectContaining({ revokeReason: "Granted for the wrong term.", from: "APPROVED", to: "REVOKED" }),
    });
    expect((await m.actions.revokeAccommodation({ id: second, reason: "Again, please." })).ok).toBe(false);
  });

  it("withdraw is for the requester (or a SUPER_ADMIN); reject needs a note", async () => {
    await as("admin");
    const req = await m.actions.requestAccommodation({ userId: u.third.id, terms: terms(), reason: REASON });
    const id = req.ok ? req.data.id : "";
    await as("admin2");
    const notMine = await m.actions.withdrawAccommodation({ id });
    expect(notMine.ok || notMine.error).toMatch(/Only the person who requested it/);
    await as("admin");
    expect(await m.actions.withdrawAccommodation({ id })).toEqual({ ok: true, data: { id } });
    expect(await row(id)).toMatchObject({ status: "WITHDRAWN", decidedById: u.admin.id });

    const req2 = await m.actions.requestAccommodation({ userId: u.third.id, terms: terms(), reason: REASON });
    const id2 = req2.ok ? req2.data.id : "";
    await as("sup");
    expect((await m.actions.rejectAccommodation({ id: id2, note: "no" })).ok).toBe(false);
    expect(await m.actions.rejectAccommodation({ id: id2, note: "No supporting letter yet." })).toEqual({ ok: true, data: { id: id2 } });
    expect(await row(id2)).toMatchObject({ status: "REJECTED", decisionNote: "No supporting letter yet.", grantedAt: null });
  });

  it("an out-of-scope student is not found for an ADMIN; a SUPER_ADMIN may approve at once", async () => {
    await as("admin");
    const out = await m.actions.requestAccommodation({ userId: u.other.id, terms: terms(), reason: REASON });
    expect(out).toEqual({ ok: false, error: "That student was not found." });

    await as("sup");
    const now = await m.actions.requestAccommodation({ userId: u.other.id, terms: terms(), reason: REASON, approveNow: true });
    expect(now).toMatchObject({ ok: true, data: { status: "APPROVED" } });
    const id = now.ok ? now.data.id : "";
    expect(await row(id)).toMatchObject({ status: "APPROVED", approvedBySuperAdminId: u.sup.id, requestedById: u.sup.id });
  });
});
