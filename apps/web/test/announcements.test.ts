import { describe, expect, it, vi } from "vitest";

/**
 * Announcements, without a database: the audience rules (a section needs a
 * batch and a department; the author's scope must cover it), the audience
 * filter, and the shape of the dashboard query (the viewer's own unread
 * announcement notifications whose announcement is live).
 */

const h = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { notification: { findMany: h.findMany } } }));

const { audienceCohort, audienceSchema, audienceWhere, describeAudience } = await import("@/lib/admin/announcement-audience");
const { buildStudentScope, scopeCovers } = await import("@/lib/auth/scope-where");
const { getActiveAnnouncements } = await import("@/server/queries/announcements");
const { safeNotificationHref } = await import("@/app/(student)/notifications/model");

describe("audienceSchema", () => {
  it("reads empty fields as every value and normalises case", () => {
    expect(audienceSchema.parse({ batchYear: "", departmentCode: "", section: "" })).toEqual({
      batchYear: null,
      departmentCode: null,
      section: null,
    });
    expect(audienceSchema.parse({ batchYear: "2027", departmentCode: "cse", section: "a" })).toEqual({
      batchYear: 2027,
      departmentCode: "CSE",
      section: "A",
    });
  });

  it("refuses a section without a batch and a department", () => {
    const parsed = audienceSchema.safeParse({ batchYear: 2027, departmentCode: null, section: "A" });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe("Choose a batch and a department before a section.");
  });

  it("refuses malformed values", () => {
    expect(audienceSchema.safeParse({ batchYear: "27", departmentCode: null, section: null }).success).toBe(false);
    expect(audienceSchema.safeParse({ batchYear: null, departmentCode: "C5E", section: null }).success).toBe(false);
  });
});

describe("audience and scope", () => {
  const cse = buildStudentScope({ id: "a", role: "ADMIN" }, [{ departmentCode: "CSE", batchYear: null }]);

  it("covers an audience inside the scope and refuses one outside it", () => {
    expect(scopeCovers(cse, audienceCohort({ batchYear: 2027, departmentCode: "CSE" }))).toBe(true);
    expect(scopeCovers(cse, audienceCohort({ batchYear: null, departmentCode: "CSE" }))).toBe(true);
    expect(scopeCovers(cse, audienceCohort({ batchYear: 2027, departmentCode: "ECE" }))).toBe(false);
    // "Every student" is wider than a department grant.
    expect(scopeCovers(cse, audienceCohort({ batchYear: null, departmentCode: null }))).toBe(false);
  });

  it("filters users by the given dimensions only", () => {
    expect(audienceWhere({ batchYear: 2027, departmentCode: "CSE", section: null })).toEqual({ batchYear: 2027, departmentCode: "CSE" });
    expect(audienceWhere({ batchYear: null, departmentCode: null, section: null })).toEqual({});
  });

  it("describes the audience in words", () => {
    expect(describeAudience({ batchYear: null, departmentCode: null, section: null })).toBe("Every student in your scope");
    expect(describeAudience({ batchYear: null, departmentCode: "CSE", section: null })).toBe("CSE · every batch");
    expect(describeAudience({ batchYear: 2027, departmentCode: "CSE", section: "A" })).toBe("CSE 2027 · A");
  });
});

describe("links", () => {
  it("only same-origin paths survive", () => {
    expect(safeNotificationHref("/sheets/rec-starter-sheet")).toBe("/sheets/rec-starter-sheet");
    expect(safeNotificationHref("https://evil.example")).toBeNull();
    expect(safeNotificationHref("//evil.example/x")).toBeNull();
    expect(safeNotificationHref("javascript:alert(1)")).toBeNull();
  });
});

describe("getActiveAnnouncements", () => {
  it("reads the viewer's own unread announcement notifications whose announcement is live", async () => {
    const now = new Date("2026-10-10T08:00:00.000Z");
    h.findMany.mockResolvedValue([
      {
        id: "n1",
        title: "Lab closed",
        body: "Friday",
        link: "/sheets",
        createdAt: now,
        announcement: { tone: "IMPORTANT" },
      },
    ]);
    const rows = await getActiveAnnouncements("stu_1", now);
    expect(h.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: "stu_1",
          readAt: null,
          kind: "announcement",
          announcement: { is: { archivedAt: null, endsAt: { gt: now }, publishedAt: { not: null } } },
        },
        orderBy: { createdAt: "desc" },
        take: 3,
      }),
    );
    expect(rows).toEqual([
      { notificationId: "n1", title: "Lab closed", body: "Friday", link: "/sheets", tone: "IMPORTANT", createdAt: now },
    ]);
  });
});
