import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/admin/problems/import: checks in order — same origin (403),
 * staff (401 / 403) before any byte of the body is read, application/zip
 * (415), declared size (413), one running import per admin (409) — then the
 * body is spooled with a byte cap, a ProblemImport row is created and the
 * import is scheduled after the response (202).
 */

const h = vi.hoisted(() => ({
  user: { current: null as null | { id: string; role: string } },
  running: null as null | { id: string },
  created: [] as unknown[],
  after: [] as (() => unknown)[],
  audit: vi.fn(),
  spoolDir: "",
  failCreate: false,
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: async () => h.user.current }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/ip", () => ({ requestIpHash: async () => null }));
vi.mock("@/lib/env", () => ({ env: () => ({ IMPORT_SPOOL_DIR: h.spoolDir }) }));
vi.mock("@/lib/authoring/import/run", () => ({ sweepStaleImports: async () => 0, IMPORT_STALE_AFTER_MS: 30 * 60 * 1000 }));
vi.mock("@/lib/authoring/import/process", () => ({ processSpooledImport: vi.fn(async () => undefined) }));
vi.mock("@/lib/db", () => ({
  db: {
    problemImport: {
      findFirst: async () => h.running,
      create: async (args: unknown) => {
        if (h.failCreate) throw new Error("database unavailable");
        h.created.push(args);
        return { id: "import-1" };
      },
    },
  },
}));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => unknown) => {
    h.after.push(fn);
  },
}));

const { POST } = await import("@/app/api/admin/problems/import/route");
const { ensurePrivateDir, spoolRequestBody, sweepSpoolFiles } = await import("@/lib/authoring/import/spool");

beforeAll(async () => {
  h.spoolDir = await mkdtemp(path.join(os.tmpdir(), "recx-spool-test-"));
});
afterAll(async () => {
  await rm(h.spoolDir, { recursive: true, force: true });
});
beforeEach(() => {
  h.user.current = { id: "admin-1", role: "ADMIN" };
  h.running = null;
  h.created.length = 0;
  h.after.length = 0;
  h.failCreate = false;
  h.audit.mockClear();
});

function request(init: { headers?: Record<string, string>; body?: BodyInit | null } = {}): Request {
  return new Request("http://localhost/api/admin/problems/import", {
    method: "POST",
    headers: { "content-type": "application/zip", "x-recx-file-name": encodeURIComponent("batch 1.zip"), ...init.headers },
    body: init.body === undefined ? Buffer.from("PK\u0003\u0004 not really a zip") : init.body,
    duplex: "half",
  } as RequestInit);
}

describe("POST /api/admin/problems/import", () => {
  it("refuses a cross-site request before checking the session", async () => {
    h.user.current = null;
    const res = await POST(request({ headers: { "sec-fetch-site": "cross-site" } }));
    expect(res.status).toBe(403);
  });

  it("refuses a signed-out caller (401) and a student (403)", async () => {
    h.user.current = null;
    expect((await POST(request())).status).toBe(401);
    h.user.current = { id: "s-1", role: "STUDENT" };
    expect((await POST(request())).status).toBe(403);
    h.user.current = { id: "t-1", role: "TA_MENTOR" };
    expect((await POST(request())).status).toBe(403);
    expect(h.created).toEqual([]);
  });

  it("needs application/zip (415) and refuses a declared size over the cap (413)", async () => {
    expect((await POST(request({ headers: { "content-type": "multipart/form-data" } }))).status).toBe(415);
    expect((await POST(request({ headers: { "content-length": String(300 * 1024 * 1024) } }))).status).toBe(413);
    expect(h.created).toEqual([]);
  });

  it("allows one running import per admin (409)", async () => {
    h.running = { id: "import-0" };
    const res = await POST(request());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ importId: "import-0" });
  });

  it("spools the body, records the import, audits it and schedules the work after the response (202)", async () => {
    const res = await POST(request());
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ importId: "import-1" });
    expect(h.created).toEqual([
      { data: expect.objectContaining({ uploadedById: "admin-1", fileName: "batch 1.zip", via: "upload", archiveSha256: expect.stringMatching(/^[0-9a-f]{64}$/) }), select: { id: true } },
    ]);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "problem.import.started", sensitivity: "NORMAL", actorId: "admin-1" }));
    expect(h.after).toHaveLength(1);
    expect((await readdir(h.spoolDir)).length).toBe(1);
  });

  it("removes the spooled archive when recording the import fails", async () => {
    const before = (await readdir(h.spoolDir)).length;
    h.failCreate = true;
    await expect(POST(request())).rejects.toThrow(/database unavailable/);
    expect((await readdir(h.spoolDir)).length).toBe(before);
  });
});

describe.skipIf(process.platform === "win32")("the spool directory", () => {
  it("tightens a directory this process owns to 0700", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "recx-spool-mode-"));
    try {
      await chmod(dir, 0o777);
      await ensurePrivateDir(dir);
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a symlink in place of the directory", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "recx-spool-link-"));
    try {
      await mkdir(path.join(base, "real"));
      await symlink(path.join(base, "real"), path.join(base, "link"));
      await expect(ensurePrivateDir(path.join(base, "link"))).rejects.toMatchObject({ status: 500 });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("sweeps archives older than the stale window and keeps fresh ones", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "recx-spool-sweep-"));
    try {
      await writeFile(path.join(dir, "old.zip"), "x");
      await writeFile(path.join(dir, "new.zip"), "x");
      await writeFile(path.join(dir, "note.txt"), "x");
      const hourAgo = new Date(Date.now() - 3_600_000);
      await utimes(path.join(dir, "old.zip"), hourAgo, hourAgo);
      expect(await sweepSpoolFiles(dir, 30 * 60 * 1000)).toBe(1);
      expect((await readdir(dir)).sort()).toEqual(["new.zip", "note.txt"]);
      expect(await sweepSpoolFiles(path.join(dir, "missing"), 1)).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("spoolRequestBody", () => {
  it("stops at the byte cap with a 413 and leaves no partial file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "recx-spool-cap-"));
    try {
      await expect(spoolRequestBody(request({ body: Buffer.alloc(4096, 1) }), { maxBytes: 1024, dir })).rejects.toMatchObject({ status: 413 });
      expect(await readdir(dir)).toEqual([]);
      const ok = await spoolRequestBody(request({ body: Buffer.alloc(512, 2) }), { maxBytes: 1024, dir });
      expect(ok.sizeBytes).toBe(512);
      expect(await readdir(dir)).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
