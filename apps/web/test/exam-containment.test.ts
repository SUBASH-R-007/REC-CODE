import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Hall containment (Phase 6d) — `src/lib/exam/containment.ts`.
 *
 * Two gate items live here, and both are about the honest limits of the
 * controls rather than about stopping anyone:
 *
 *   8. "SEB hash verification rejects absence and mismatch with an audit row";
 *      and SPEC §5's note that server-side key verification "is the part most
 *      deployments skip and the part that matters".
 *   - the CIDR allowlist is re-checked per request, so "leaving the lab
 *      network ends the session" rather than being a start-time formality.
 *
 * The configuration failure modes get as much attention as the refusals,
 * because a hall whose allowlist has a typo in it must not lock out a room
 * full of candidates — that would be a far worse outcome than the signal is
 * worth.
 */

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const h = vi.hoisted(() => ({
  examSession: null as { allowedCidrs: string[]; label: string } | null,
  settings: [] as Array<{ key: string; value: unknown }>,
  ip: null as string | null,
  audit: vi.fn(),
  findSession: vi.fn(),
  findSettings: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    examSession: { findUnique: h.findSession },
    platformSetting: { findMany: h.findSettings },
  },
}));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/ip", () => ({ requestIp: async () => h.ip, requestIpHash: async () => "hash" }));

const { checkContainment, sebKeysFor, verifySebRequest } = await import("@/lib/exam/containment");

const EXAM_URL = "https://code.rec.edu.in/api/exam/att_1/hb";

const attempt = (over: Record<string, unknown> = {}) => ({
  id: "att_1",
  userId: "user_1",
  assessmentId: "a1",
  examSessionId: "sess_1",
  proctorMode: "LAB_SUPERVISED",
  ...over,
});

const request = (headers: Record<string, string> = {}) => new Request(EXAM_URL, { method: "POST", headers });

beforeEach(() => {
  vi.clearAllMocks();
  h.ip = "10.12.3.4";
  h.examSession = { allowedCidrs: ["10.12.0.0/16"], label: "Lab 3" };
  h.settings = [];
  h.findSession.mockImplementation(async () => h.examSession);
  h.findSettings.mockImplementation(async () => h.settings);
});

describe("the network allowlist", () => {
  it("admits a candidate inside the hall's blocks", async () => {
    const result = await checkContainment({ request: request(), attempt: attempt() });
    expect(result.ok).toBe(true);
    expect(result.networkUnrestricted).toBe(false);
  });

  it("refuses a candidate outside them", async () => {
    h.ip = "49.207.1.1";
    const result = await checkContainment({ request: request(), attempt: attempt() });
    expect(result).toMatchObject({ ok: false, refusal: "outside_allowlist" });
    expect(result.message).toContain("exam hall network");
  });

  it("tells a candidate in the hall that the network has changed, not that they cheated", async () => {
    h.ip = "49.207.1.1";
    const { message } = await checkContainment({ request: request(), attempt: attempt() });
    expect(message).toContain("if you are in the hall, the network has changed");
    expect(message?.toLowerCase()).not.toMatch(/cheat|malpractice|violation/);
  });

  it("checks nothing for an unsupervised assessment", async () => {
    h.ip = "49.207.1.1";
    const result = await checkContainment({ request: request(), attempt: attempt({ proctorMode: "ADVISORY" }) });
    expect(result.ok).toBe(true);
    expect(h.findSession).not.toHaveBeenCalled();
  });

  it("checks nothing when the candidate is not seated in a hall", async () => {
    h.ip = "49.207.1.1";
    const result = await checkContainment({ request: request(), attempt: attempt({ examSessionId: null }) });
    expect(result.ok).toBe(true);
  });

  it("does not lock out a hall whose allowlist is empty", async () => {
    // A configuration nobody filled in must not stop a room full of
    // candidates sitting their exam.
    h.examSession = { allowedCidrs: [], label: "Lab 3" };
    h.ip = "49.207.1.1";
    const result = await checkContainment({ request: request(), attempt: attempt() });
    expect(result).toMatchObject({ ok: true, networkUnrestricted: true });
  });

  it("reports an unparseable entry while the valid ones still decide", async () => {
    h.examSession = { allowedCidrs: ["10.12.0.0/16", "oops"], label: "Lab 3" };
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await checkContainment({ request: request(), attempt: attempt() });
    expect(result.ok).toBe(true);
    expect(result.invalidCidrs).toEqual(["oops"]);
  });

  it("does not lock out a hall whose every entry is a typo", async () => {
    h.examSession = { allowedCidrs: ["10.12.0.0//16", "lab-3"], label: "Lab 3" };
    h.ip = "49.207.1.1";
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await checkContainment({ request: request(), attempt: attempt() });
    expect(result).toMatchObject({ ok: true, networkUnrestricted: true });
    expect(result.invalidCidrs).toHaveLength(2);
  });

  it("refuses when an allowlist is set and the address cannot be determined", async () => {
    // A check that silently passes when it cannot run is not a check.
    h.ip = null;
    const result = await checkContainment({ request: request(), attempt: attempt() });
    expect(result).toMatchObject({ ok: false, refusal: "outside_allowlist" });
  });

  it("audits a refusal at SECURITY, with the hall's blocks and never the address", async () => {
    h.ip = "49.207.1.1";
    await checkContainment({ request: request(), attempt: attempt(), audited: true });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "assessment.attempt.outside_allowlist",
        sensitivity: "SECURITY",
        targetUserId: "user_1",
      }),
    );
    const entry = h.audit.mock.calls[0]![0] as { metadata: Record<string, unknown> };
    expect(JSON.stringify(entry.metadata)).toContain("10.12.0.0/16");
    // SPEC §4: never a raw IP, anywhere — including in an audit row.
    expect(JSON.stringify(entry.metadata)).not.toContain("49.207.1.1");
  });

  it("does not audit on the heartbeat path, which runs every ten seconds", async () => {
    // 360 SECURITY rows an hour for one candidate whose hall wifi dropped
    // would bury the rows a human needs to read.
    h.ip = "49.207.1.1";
    await checkContainment({ request: request(), attempt: attempt(), audited: false });
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe("Safe Exam Browser", () => {
  const kiosk = () => attempt({ proctorMode: "KIOSK_SEB", examSessionId: "sess_1" });
  const CONFIG_KEY = "config-key-0123456789abcdef";
  const BROWSER_KEY = "browser-key-fedcba9876543210";
  // The URL SEB hashes: the request URL with no query string.
  const hashOf = (key: string) => sha256(EXAM_URL + key);

  beforeEach(() => {
    h.settings = [{ key: "seb:sess_1", value: { configKey: CONFIG_KEY, browserExamKey: BROWSER_KEY } }];
    h.examSession = { allowedCidrs: [], label: "Lab 3" };
  });

  it("admits a request with correct hashes", async () => {
    const result = await checkContainment({
      request: request({
        "x-safeexambrowser-configkeyhash": hashOf(CONFIG_KEY),
        "x-safeexambrowser-requesthash": hashOf(BROWSER_KEY),
      }),
      attempt: kiosk(),
    });
    expect(result.ok).toBe(true);
  });

  it("refuses an ordinary browser, and says to open the .seb file", async () => {
    const result = await checkContainment({ request: request(), attempt: kiosk() });
    expect(result).toMatchObject({ ok: false, refusal: "seb_required" });
    expect(result.message).toContain(".seb file");
  });

  it("refuses a wrong hash", async () => {
    const result = await checkContainment({
      request: request({
        "x-safeexambrowser-configkeyhash": sha256("wrong"),
        "x-safeexambrowser-requesthash": hashOf(BROWSER_KEY),
      }),
      attempt: kiosk(),
    });
    expect(result).toMatchObject({ ok: false, refusal: "seb_required" });
  });

  it("refuses a kiosk assessment with no keys configured, and blames the setup", async () => {
    h.settings = [];
    const result = await checkContainment({ request: request(), attempt: kiosk() });
    expect(result).toMatchObject({ ok: false, refusal: "seb_required" });
    expect(result.message).toContain("not something you have done");
  });

  it("audits a refusal at SECURITY with the reason", async () => {
    await checkContainment({ request: request(), attempt: kiosk(), audited: true });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "assessment.attempt.seb_refused", sensitivity: "SECURITY" }),
    );
    const entry = h.audit.mock.calls[0]![0] as { metadata: { refusal: string } };
    expect(entry.metadata.refusal).toBe("absent");
  });

  it("ignores the query string, so a cache-busting parameter cannot break a sitting", async () => {
    const verdict = await verifySebRequest(
      new Request(`${EXAM_URL}?_=1700000000`, {
        method: "POST",
        headers: {
          "x-safeexambrowser-configkeyhash": hashOf(CONFIG_KEY),
          "x-safeexambrowser-requesthash": hashOf(BROWSER_KEY),
        },
      }),
      "sess_1",
    );
    expect(verdict.ok).toBe(true);
  });

  it("checks nothing for a non-kiosk assessment", async () => {
    const result = await checkContainment({ request: request(), attempt: attempt({ proctorMode: "ADVISORY" }) });
    expect(result.ok).toBe(true);
  });
});

describe("sebKeysFor", () => {
  it("prefers the exam session's own keys over the platform-wide ones", async () => {
    h.settings = [
      { key: "seb", value: { configKey: "platform-wide-key-aaaaaaaa", browserExamKey: null } },
      { key: "seb:sess_1", value: { configKey: "this-hall-key-bbbbbbbb", browserExamKey: null } },
    ];
    expect(await sebKeysFor("sess_1")).toEqual({ configKey: "this-hall-key-bbbbbbbb", browserExamKey: null });
  });

  it("falls back to the platform-wide keys, for a college with one .seb file", async () => {
    h.settings = [{ key: "seb", value: { configKey: "platform-wide-key-aaaaaaaa", browserExamKey: null } }];
    expect(await sebKeysFor("sess_1")).toEqual({ configKey: "platform-wide-key-aaaaaaaa", browserExamKey: null });
  });

  it("treats an empty string as unset, so a cleared field does not read as a key", async () => {
    h.settings = [{ key: "seb", value: { configKey: "", browserExamKey: "" } }];
    expect(await sebKeysFor("sess_1")).toEqual({ configKey: null, browserExamKey: null });
  });

  it("ignores a malformed setting rather than throwing mid-request", async () => {
    h.settings = [{ key: "seb", value: "not an object" }];
    expect(await sebKeysFor(null)).toEqual({ configKey: null, browserExamKey: null });
  });

  it("asks only for the keys it needs", async () => {
    await sebKeysFor("sess_9");
    expect(h.findSettings).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: { in: ["seb:sess_9", "seb"] } } }),
    );
  });
});
