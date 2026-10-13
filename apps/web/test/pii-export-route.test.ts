import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /super/data/exports/[id]: requester only, EXECUTED and inside the
 * 24-hour window, at most 3 downloads (the conditional increment is the
 * database's), formula-escaped CSV, never cached, each download audited.
 */

const h = vi.hoisted(() => ({
  actor: { id: "super_1", role: "SUPER_ADMIN" as string },
  op: null as null | Record<string, unknown>,
  downloads: 0,
  users: [] as Array<Record<string, unknown>>,
  audit: vi.fn(),
}));

vi.mock("@/lib/auth/guards", async () => {
  const { ForbiddenError } = await import("@/lib/errors");
  return {
    requireSuperAdmin: async () => {
      if (h.actor.role !== "SUPER_ADMIN") throw new ForbiddenError();
      return h.actor;
    },
  };
});
vi.mock("@/lib/db", () => ({
  db: {
    privilegedOperation: { findUnique: async () => h.op },
    // The conditional "artifactDownloads < 3" increment.
    $queryRaw: async () => {
      if (h.downloads >= 3) return [];
      h.downloads++;
      return [{ artifactDownloads: h.downloads }];
    },
    user: {
      findMany: async ({ where }: { where: { AND?: Array<{ id?: { gt: string } }> } }) => {
        const after = where.AND?.[1]?.id?.gt;
        return after ? h.users.filter((u) => String(u.id) > after) : h.users;
      },
    },
  },
}));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/ip", () => ({ requestIpHash: async () => "iphash" }));

const { GET } = await import("@/app/super/data/exports/[id]/route");
const { csvCell } = await import("@/lib/privileged/csv");

const call = (id = "op_1") => GET(new Request(`http://localhost/super/data/exports/${id}`), { params: Promise.resolve({ id }) });

beforeEach(() => {
  h.actor = { id: "super_1", role: "SUPER_ADMIN" };
  h.downloads = 0;
  h.audit.mockClear();
  h.op = {
    id: "op_1",
    kind: "PII_EXPORT",
    status: "EXECUTED",
    requestedById: "super_1",
    payload: { filter: { batchYear: 2027 }, columns: ["collegeId", "firstName", "email"] },
    artifactAvailableUntil: new Date(Date.now() + 3_600_000),
  };
  h.users = [
    { id: "u1", collegeId: "2116231001001", firstName: "Asha", email: "asha@example.test" },
    { id: "u2", collegeId: "2116231001002", firstName: "=HYPERLINK(\"http://x\")", email: "b@example.test" },
  ];
});

describe("PII export download", () => {
  it("streams a no-store CSV with formula escaping and audits the download", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    const body = await response.text();
    const lines = body.trim().split("\r\n");
    expect(lines[0]).toBe('"collegeId","firstName","email"');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "pii.export.downloaded", sensitivity: "SECURITY", metadata: expect.objectContaining({ download: 1 }) }),
    );
  });

  it("allows at most 3 downloads", async () => {
    for (let i = 0; i < 3; i++) expect((await call()).status).toBe(200);
    const fourth = await call();
    expect(fourth.status).toBe(410);
    expect(h.audit).toHaveBeenCalledTimes(3);
  });

  it("is for the requester only (another super-admin sees 404)", async () => {
    h.actor = { id: "super_2", role: "SUPER_ADMIN" };
    expect((await call()).status).toBe(404);
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.downloads).toBe(0);
  });

  it("refuses outside the window or before execution", async () => {
    h.op = { ...h.op!, artifactAvailableUntil: new Date(Date.now() - 1) };
    expect((await call()).status).toBe(410);
    h.op = { ...h.op!, status: "APPROVED", artifactAvailableUntil: null };
    expect((await call()).status).toBe(409);
    expect(h.downloads).toBe(0);
  });

  it("is SUPER_ADMIN only and refuses a malformed id", async () => {
    h.actor = { id: "admin_1", role: "ADMIN" };
    expect((await call()).status).toBe(403);
    h.actor = { id: "super_1", role: "SUPER_ADMIN" };
    expect((await call("../../etc")).status).toBe(404);
  });
});

describe("csvCell", () => {
  it.each([
    ["=1+1", `"'=1+1"`],
    ["+91 98", `"'+91 98"`],
    ["-5", `"'-5"`],
    ["@SUM(A1)", `"'@SUM(A1)"`],
    ["\tTab", `"'\tTab"`],
    ['Say "hi"', `"Say ""hi"""`],
    [null, `""`],
    [2027, `"2027"`],
  ] as const)("%j → %s", (input, out) => {
    expect(csvCell(input)).toBe(out);
  });

  it("writes dates as ISO strings", () => {
    expect(csvCell(new Date("2026-10-10T00:00:00Z"))).toBe(`"2026-10-10T00:00:00.000Z"`);
  });
});
