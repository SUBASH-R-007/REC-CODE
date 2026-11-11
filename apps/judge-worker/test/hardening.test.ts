import { describe, expect, it } from "vitest";
import {
  BLACKLISTED_MODULES,
  REQUIRED_SYSCTLS,
  checkHostHardening,
  evaluateHardening,
  hardeningIntake,
  sysctlPath,
  type SysctlReading,
} from "../src/hardening";

/** A reading map in which every required key holds its expected value. */
function allGood(): Map<string, SysctlReading> {
  const m = new Map<string, SysctlReading>();
  for (const { key, expected } of REQUIRED_SYSCTLS) m.set(key, { value: expected });
  return m;
}

const NO_MODULES = { text: "" };

describe("sysctlPath", () => {
  it("maps a dotted key to its /proc/sys path", () => {
    expect(sysctlPath("kernel.yama.ptrace_scope")).toBe("/proc/sys/kernel/yama/ptrace_scope");
    expect(sysctlPath("net.core.bpf_jit_harden")).toBe("/proc/sys/net/core/bpf_jit_harden");
  });
});

describe("evaluateHardening", () => {
  it("passes when every key matches and no blacklisted module is loaded", () => {
    const report = evaluateHardening(allGood(), NO_MODULES);
    expect(report.ok).toBe(true);
    expect(report.failures).toEqual([]);
  });

  it("checks exactly the required keys (sysctl file + modules_disabled)", () => {
    const keys = REQUIRED_SYSCTLS.map((s) => s.key);
    expect(keys).toContain("kernel.unprivileged_userns_clone");
    expect(keys).toContain("kernel.modules_disabled");
    expect(keys).toContain("kernel.core_pattern");
    expect(keys).toHaveLength(14);
  });

  it("fails a wrong value and quotes the expected and actual", () => {
    const m = allGood();
    m.set("kernel.kptr_restrict", { value: "1" });
    const report = evaluateHardening(m, NO_MODULES);
    expect(report.ok).toBe(false);
    expect(report.failures.some((f) => f.includes("kernel.kptr_restrict") && f.includes("expected 2") && f.includes("found 1"))).toBe(true);
  });

  it("treats a missing key as a failure (unverifiable is not hardened)", () => {
    const m = allGood();
    m.delete("kernel.unprivileged_userns_clone");
    const report = evaluateHardening(m, NO_MODULES);
    expect(report.ok).toBe(false);
    expect(report.failures.some((f) => f.includes("unprivileged_userns_clone") && f.includes("missing"))).toBe(true);
  });

  it("treats an unreadable (EACCES) key as an unverifiable failure, not a pass", () => {
    const m = allGood();
    m.set("net.core.bpf_jit_harden", { error: "EACCES" });
    const report = evaluateHardening(m, NO_MODULES);
    expect(report.ok).toBe(false);
    expect(report.failures.some((f) => f.includes("bpf_jit_harden") && f.includes("unverifiable"))).toBe(true);
  });

  it("trims surrounding whitespace before comparing", () => {
    const m = allGood();
    m.set("kernel.core_pattern", { value: "|/bin/false\n" });
    expect(evaluateHardening(m, NO_MODULES).ok).toBe(true);
  });

  it("detects a loaded blacklisted module, including the n-hdlc/n_hdlc name difference", () => {
    const modules = { text: "n_hdlc 16384 0 - Live 0x0\next4 123 1 - Live 0x0\n" };
    const report = evaluateHardening(allGood(), modules);
    expect(report.ok).toBe(false);
    expect(report.failures.some((f) => f.includes("n-hdlc") && f.includes("loaded"))).toBe(true);
  });

  it("flags every blacklisted module by its modprobe name", () => {
    const modules = { text: BLACKLISTED_MODULES.map((m) => `${m.replace(/-/g, "_")} 1 0 - Live 0x0`).join("\n") };
    const report = evaluateHardening(allGood(), modules);
    expect(report.failures.filter((f) => f.includes("loaded"))).toHaveLength(BLACKLISTED_MODULES.length);
  });

  it("treats unreadable /proc/modules as a failure", () => {
    const report = evaluateHardening(allGood(), { error: "EACCES" });
    expect(report.ok).toBe(false);
    expect(report.failures.some((f) => f.includes("/proc/modules"))).toBe(true);
  });
});

describe("hardeningIntake", () => {
  const okReport = { ok: true, failures: [] };
  const badReport = { ok: false, failures: ["kernel.io_uring_disabled: expected 2, found 0"] };

  it("allows a hardened host with no warning", () => {
    expect(hardeningIntake(okReport, { production: true, devAllowUnhardened: false })).toEqual({ allowed: true, warning: null });
  });

  it("refuses an unhardened host in production", () => {
    const r = hardeningIntake(badReport, { production: true, devAllowUnhardened: false });
    expect(r.allowed).toBe(false);
  });

  it("refuses an unhardened host in development unless the dev override is set", () => {
    expect(hardeningIntake(badReport, { production: false, devAllowUnhardened: false }).allowed).toBe(false);
    const allowed = hardeningIntake(badReport, { production: false, devAllowUnhardened: true });
    expect(allowed.allowed).toBe(true);
    if (allowed.allowed) expect(allowed.warning).toMatch(/RECX_DEV_ALLOW_UNHARDENED_HOST/);
  });
});

describe("checkHostHardening (reader integration)", () => {
  it("reads through an injected reader and evaluates", async () => {
    const values = new Map<string, string>();
    for (const { key, expected } of REQUIRED_SYSCTLS) values.set(sysctlPath(key), expected);
    const report = await checkHostHardening(async (path) => {
      if (path === "/proc/modules") return "";
      const v = values.get(path);
      if (v === undefined) throw Object.assign(new Error("nope"), { code: "ENOENT" });
      return v;
    });
    expect(report.ok).toBe(true);
  });

  it("surfaces a reader error for a key as a failure", async () => {
    const report = await checkHostHardening(async (path) => {
      if (path === "/proc/modules") return "";
      if (path === sysctlPath("kernel.io_uring_disabled")) throw Object.assign(new Error("denied"), { code: "EACCES" });
      const entry = REQUIRED_SYSCTLS.find((s) => sysctlPath(s.key) === path);
      if (!entry) throw Object.assign(new Error("nope"), { code: "ENOENT" });
      return entry.expected;
    });
    expect(report.ok).toBe(false);
    expect(report.failures.some((f) => f.includes("io_uring_disabled"))).toBe(true);
  });
});
