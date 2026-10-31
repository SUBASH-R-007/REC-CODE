import { readFile } from "node:fs/promises";

/**
 * Host hardening check, run by the worker itself at boot (in addition to
 * infra/judge/verify-host.sh, which systemd runs as root before every start).
 *
 * Reads /proc/sys for the exact values in infra/judge/sysctl/99-recjudge.conf
 * plus kernel.modules_disabled, and /proc/modules for the blacklisted
 * modules in infra/judge/modprobe/recjudge-blacklist.conf. A key that is
 * missing on this kernel or cannot be read is a failure, never a pass:
 * "unverifiable" is not "hardened". The result goes into every heartbeat as
 * hostHardening {ok, failures}.
 *
 * In production a node that fails takes no jobs at all and keeps
 * heartbeating its failures (the web app quarantines it). Outside
 * production, RECX_DEV_ALLOW_UNHARDENED_HOST=1 lets a development box (WSL2
 * cannot be hardened) take jobs anyway, with a loud warning.
 */

export interface RequiredSysctl {
  key: string;
  expected: string;
}

/** Keep in step with infra/judge/sysctl/99-recjudge.conf and infra/judge/verify-host.sh. */
export const REQUIRED_SYSCTLS: readonly RequiredSysctl[] = [
  { key: "kernel.unprivileged_userns_clone", expected: "0" },
  { key: "kernel.unprivileged_bpf_disabled", expected: "2" },
  { key: "net.core.bpf_jit_harden", expected: "2" },
  { key: "kernel.io_uring_disabled", expected: "2" },
  { key: "kernel.dmesg_restrict", expected: "1" },
  { key: "kernel.kptr_restrict", expected: "2" },
  { key: "kernel.perf_event_paranoid", expected: "3" },
  { key: "kernel.yama.ptrace_scope", expected: "3" },
  { key: "vm.unprivileged_userfaultfd", expected: "0" },
  { key: "kernel.modules_disabled", expected: "1" },
  { key: "fs.protected_symlinks", expected: "1" },
  { key: "fs.protected_hardlinks", expected: "1" },
  { key: "fs.suid_dumpable", expected: "0" },
  { key: "kernel.core_pattern", expected: "|/bin/false" },
];

/** Keep in step with infra/judge/modprobe/recjudge-blacklist.conf. */
export const BLACKLISTED_MODULES: readonly string[] = [
  "dccp",
  "sctp",
  "rds",
  "tipc",
  "n-hdlc",
  "cramfs",
  "freevxfs",
  "jffs2",
  "hfs",
  "hfsplus",
  "squashfs",
  "udf",
];

/** One /proc/sys read: its value, or the errno code that stopped it. */
export type SysctlReading = { value: string } | { error: string };

export interface HardeningReport {
  ok: boolean;
  failures: string[];
}

export function sysctlPath(key: string): string {
  return `/proc/sys/${key.replace(/\./g, "/")}`;
}

/** /proc/modules names use '_' where modprobe accepts '-' (n-hdlc is n_hdlc). */
function moduleName(name: string): string {
  return name.replace(/-/g, "_");
}

function describeError(code: string): string {
  switch (code) {
    case "ENOENT":
      return "missing: this kernel has no such setting";
    case "EACCES":
    case "EPERM":
      return `unverifiable: ${code} (readable by root only on this host)`;
    default:
      return `unreadable: ${code}`;
  }
}

/**
 * Pure evaluation of what was read. `modules` is the text of /proc/modules,
 * or an error code when it could not be read.
 */
export function evaluateHardening(
  readings: ReadonlyMap<string, SysctlReading>,
  modules: { text: string } | { error: string },
): HardeningReport {
  const failures: string[] = [];
  for (const { key, expected } of REQUIRED_SYSCTLS) {
    const reading = readings.get(key) ?? { error: "ENOENT" };
    if ("error" in reading) {
      failures.push(`${key}: expected ${expected}, ${describeError(reading.error)}`);
      continue;
    }
    const actual = reading.value.trim();
    if (actual !== expected) failures.push(`${key}: expected ${expected}, found ${actual.slice(0, 200) || "(empty)"}`);
  }

  if ("error" in modules) {
    failures.push(`/proc/modules: ${describeError(modules.error)}; the module blacklist cannot be verified`);
  } else {
    const loaded = new Set(
      modules.text
        .split("\n")
        .map((line) => line.split(/\s+/)[0] ?? "")
        .filter(Boolean),
    );
    for (const name of BLACKLISTED_MODULES) {
      if (loaded.has(moduleName(name))) failures.push(`module ${name} is loaded (blacklisted)`);
    }
  }
  return { ok: failures.length === 0, failures };
}

function errnoCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : "EIO";
}

export type TextReader = (path: string) => Promise<string>;

const readText: TextReader = (path) => readFile(path, "utf8");

/** Read every required key and /proc/modules, then evaluate. Never throws. */
export async function checkHostHardening(read: TextReader = readText): Promise<HardeningReport> {
  const readings = new Map<string, SysctlReading>();
  for (const { key } of REQUIRED_SYSCTLS) {
    try {
      readings.set(key, { value: await read(sysctlPath(key)) });
    } catch (error) {
      readings.set(key, { error: errnoCode(error) });
    }
  }
  let modules: { text: string } | { error: string };
  try {
    modules = { text: await read("/proc/modules") };
  } catch (error) {
    modules = { error: errnoCode(error) };
  }
  return evaluateHardening(readings, modules);
}

export type IntakePermission =
  | { allowed: true; warning: string | null }
  | { allowed: false; reason: string };

/**
 * Whether a node with this hardening report may take jobs.
 *  - hardened: yes;
 *  - not hardened, production: never;
 *  - not hardened, development with RECX_DEV_ALLOW_UNHARDENED_HOST=1: yes, warned;
 *  - not hardened otherwise: no (set the variable on a development box).
 */
export function hardeningIntake(
  report: HardeningReport,
  env: { production: boolean; devAllowUnhardened: boolean },
): IntakePermission {
  if (report.ok) return { allowed: true, warning: null };
  const summary = `${report.failures.length} kernel hardening check(s) failed`;
  if (env.production) {
    return { allowed: false, reason: `${summary}; a production node takes no jobs until the host is rebuilt` };
  }
  if (env.devAllowUnhardened) {
    return {
      allowed: true,
      warning: `${summary}; taking jobs anyway because RECX_DEV_ALLOW_UNHARDENED_HOST=1 (development only, never on a judge host)`,
    };
  }
  return {
    allowed: false,
    reason: `${summary}; set RECX_DEV_ALLOW_UNHARDENED_HOST=1 to judge on this development box anyway`,
  };
}
