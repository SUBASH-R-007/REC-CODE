import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Announcements against a real Postgres (recx_test), through the server
 * actions and the dashboard query: an audience outside the author's scope is
 * refused; publishing fans out one notification per in-scope ACTIVE or
 * SOFT_RESTRICTED student of the audience and nobody else; the dashboard
 * shows the viewer's unread, live ones only; dismissing (marking read) and
 * archiving hide the banner; published text cannot change.
 *
 * Opt-in: RECX_DB_TESTS=1 (RECX_TEST_DATABASE_URL overrides the URL).
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";

const state = vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";
  }
  return { user: null as unknown, audits: [] as Array<Record<string, unknown>> };
});

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: async () => state.user, destroyAllSessions: async () => undefined }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));
vi.mock("@/lib/rate-limit", () => ({ hitRateLimit: async () => ({ allowed: true, remaining: 9, retryAfterMs: 0 }) }));
vi.mock("@/lib/ip", () => ({ requestIpHash: async () => null }));
vi.mock("@/lib/audit", () => ({
  audit: async (entry: Record<string, unknown>) => {
    state.audits.push(entry);
  },
}));

type M = {
  db: (typeof import("@/lib/db"))["db"];
  actions: typeof import("@/server/actions/admin-announcements");
  notifications: typeof import("@/server/actions/notifications");
  banner: typeof import("@/server/queries/announcements");
  support: typeof import("./support/admin-db");
};

const letters = (n: number) => Array.from(randomBytes(n), (b) => String.fromCharCode(65 + (b % 26))).join("");

describe.skipIf(!ENABLED)("announcements against recx_test", () => {
  const tag = `an${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
  const deptA = `V${letters(5)}`;
  const deptB = `W${letters(5)}`;
  let m: M;
  let u: Record<"sup" | "admin" | "a1" | "a2" | "a3" | "a4" | "b1", import("./support/admin-db").TestUser>;
  const as = async (key: keyof typeof u) => {
    state.user = await m.db.user.findUniqueOrThrow({ where: { id: u[key].id } });
  };
  const draft = (fields: Record<string, unknown> = {}) => ({
    title: `${tag} notice`,
    body: "The lab is closed on Friday.\nBring your ID card on Monday.",
    tone: "IMPORTANT" as const,
    link: "/sheets",
    audience: { batchYear: 2027, departmentCode: deptA, section: null },
    endsAt: new Date(Date.now() + 3 * 86_400_000),
    ...fields,
  });

  beforeAll(async () => {
    m = {
      db: (await import("@/lib/db")).db,
      actions: await import("@/server/actions/admin-announcements"),
      notifications: await import("@/server/actions/notifications"),
      banner: await import("@/server/queries/announcements"),
      support: await import("./support/admin-db"),
    };
    u = await m.support.createUsers(m.db, tag, {
      sup: { role: "SUPER_ADMIN" },
      admin: { role: "ADMIN" },
      a1: { batchYear: 2027, departmentCode: deptA, section: "A" },
      a2: { batchYear: 2027, departmentCode: deptA, section: "B", status: "SOFT_RESTRICTED" },
      a3: { batchYear: 2027, departmentCode: deptA, section: "A", status: "DISABLED" },
      a4: { batchYear: 2026, departmentCode: deptA, section: "A" },
      b1: { batchYear: 2027, departmentCode: deptB, section: "A" },
    });
    await m.support.grantScope(m.db, u.admin.id, u.sup.id, { departmentCode: deptA, batchYear: null });
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

  let published = "";

  it("an audience outside the author's scope is refused, and so is an off-site link", async () => {
    await as("admin");
    const outside = await m.actions.saveAnnouncementDraft(draft({ audience: { batchYear: 2027, departmentCode: deptB, section: null } }));
    expect(outside).toEqual({ ok: false, error: "That audience is outside your scope." });
    const everyone = await m.actions.saveAnnouncementDraft(draft({ audience: { batchYear: null, departmentCode: null, section: null } }));
    expect(everyone).toEqual({ ok: false, error: "That audience is outside your scope." });
    const link = await m.actions.saveAnnouncementDraft(draft({ link: "https://evil.example" }));
    expect(link.ok).toBe(false);
    expect(await m.db.announcement.count({ where: { createdById: u.admin.id } })).toBe(0);
  });

  it("publishing fans out to the in-scope current students of the audience only", async () => {
    await as("admin");
    const saved = await m.actions.saveAnnouncementDraft(draft());
    expect(saved.ok).toBe(true);
    published = saved.ok ? saved.data.id : "";
    expect(await m.db.notification.count({ where: { announcementId: published } })).toBe(0);

    state.audits.length = 0;
    expect(await m.actions.publishAnnouncement({ id: published })).toEqual({ ok: true, data: { recipientCount: 2 } });
    const recipients = await m.db.notification.findMany({ where: { announcementId: published }, select: { userId: true, kind: true } });
    expect(recipients.map((r) => r.userId).sort()).toEqual([u.a1.id, u.a2.id].sort());
    expect(recipients.every((r) => r.kind === "announcement")).toBe(true);
    expect(await m.db.announcement.findUniqueOrThrow({ where: { id: published } })).toMatchObject({
      recipientCount: 2,
      publishedById: u.admin.id,
    });
    expect(state.audits[0]).toMatchObject({
      action: "announcement.published",
      sensitivity: "SENSITIVE",
      metadata: expect.objectContaining({ recipientCount: 2 }),
    });

    const twice = await m.actions.publishAnnouncement({ id: published });
    expect(twice.ok || twice.error).toMatch(/already published/);
    const edit = await m.actions.saveAnnouncementDraft({ ...draft({ title: "Changed" }), id: published });
    expect(edit.ok || edit.error).toMatch(/already published/);
  });

  it("the dashboard shows the viewer's unread live announcements; dismissing clears it", async () => {
    const forA1 = await m.banner.getActiveAnnouncements(u.a1.id);
    expect(forA1).toHaveLength(1);
    expect(forA1[0]).toMatchObject({ title: `${tag} notice`, tone: "IMPORTANT", link: "/sheets" });
    expect(await m.banner.getActiveAnnouncements(u.b1.id)).toEqual([]);
    expect(await m.banner.getActiveAnnouncements(u.a3.id)).toEqual([]);

    await as("a1");
    expect(await m.notifications.markNotificationRead({ id: forA1[0]!.notificationId })).toEqual({ ok: true, data: { updated: 1 } });
    expect(await m.banner.getActiveAnnouncements(u.a1.id)).toEqual([]);
    expect(await m.banner.getActiveAnnouncements(u.a2.id)).toHaveLength(1);
  });

  it("archiving hides the banner but keeps the notifications", async () => {
    await as("admin");
    expect(await m.actions.archiveAnnouncement({ id: published })).toEqual({ ok: true, data: { id: published } });
    expect(await m.banner.getActiveAnnouncements(u.a2.id)).toEqual([]);
    expect(await m.db.notification.count({ where: { announcementId: published } })).toBe(2);
    const again = await m.actions.archiveAnnouncement({ id: published });
    expect(again.ok || again.error).toMatch(/already archived/);
  });

  it("an ended announcement no longer shows", async () => {
    await as("admin");
    const saved = await m.actions.saveAnnouncementDraft(draft({ tone: "INFO", link: undefined }));
    const id = saved.ok ? saved.data.id : "";
    await m.actions.publishAnnouncement({ id });
    expect((await m.banner.getActiveAnnouncements(u.a2.id)).map((a) => a.tone)).toEqual(["INFO"]);
    await m.db.announcement.update({ where: { id }, data: { endsAt: new Date(Date.now() - 1000) } });
    expect(await m.banner.getActiveAnnouncements(u.a2.id)).toEqual([]);
  });
});
