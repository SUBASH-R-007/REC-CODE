import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  JVM_LANGUAGE_KEYS,
  LANGUAGE_CATALOG,
  LANGUAGE_KEYS,
  LIMITS,
  jvmRunFlags,
  toolchainDirs,
  wallTimeSecFor,
  type LanguageRuntime,
} from "@recx/shared";
import { boxIdsForSlot, type BoxRole } from "../src/config";
import { InfraError } from "../src/errors";
import { compileLimits, runArgv, runLimits } from "../src/judge/limits";
import { buildIsolateArgv, type IsolateArgvOptions } from "../src/sandbox/isolate";

const ROLES: BoxRole[] = ["run", "compile", "checker"];
const FORBIDDEN_FLAGS = [/^--share-net/, /^--full-env/, /^-e$/, /^--mem(=|$)/, /^-m/, /^--inherit-fds/, /^--special-files/, /^--tty-hack/];

function optionsFor(rt: LanguageRuntime, role: BoxRole, slot = 0): Extract<IsolateArgvOptions, { action: "run" }> {
  const spec = { timeLimitMs: 2000, memoryLimitKb: 262_144, language: rt };
  const command = role === "compile" ? (rt.compile?.argv ?? rt.run.argv) : runArgv(spec);
  return {
    action: "run",
    boxId: boxIdsForSlot(0, slot)[role],
    metaFile: `/tmp/recjudge-meta-test/box-${role}.meta`,
    syntheticEtc: "/var/lib/recjudge/etc",
    toolchainIds: [rt.toolchainId, ...rt.extraToolchainIds],
    env: rt.env,
    limits: role === "compile" ? compileLimits(rt) : runLimits(spec),
    stdin: role === "compile" ? null : "input.txt",
    stdout: "output.txt",
    stderr: "error.txt",
    argv: command,
  };
}

/** isolate options only: everything before "--run --" (after it is the program's own argv). */
function isolateFlags(argv: string[]): string[] {
  const end = argv.indexOf("--run");
  expect(end).toBeGreaterThan(0);
  expect(argv[end + 1]).toBe("--");
  return argv.slice(0, end);
}

describe("buildIsolateArgv — every language × every box", () => {
  for (const key of LANGUAGE_KEYS) {
    const rt = LANGUAGE_CATALOG[key];
    for (const role of ROLES) {
      it(`${key} / ${role}`, () => {
        const options = optionsFor(rt, role);
        const argv = buildIsolateArgv(options);
        const flags = isolateFlags(argv);

        // Never: shared network, inherited env, address-space limit, inherited fds, special files, tty hack.
        for (const flag of flags) {
          for (const forbidden of FORBIDDEN_FLAGS) expect(flag, `forbidden ${flag}`).not.toMatch(forbidden);
        }
        expect(argv.join(" ")).not.toContain("share-net");

        // Always: cgroup, explicit box, meta outside the box, no default dirs.
        expect(flags.slice(0, 2)).toEqual(["--cg", `--box-id=${options.boxId}`]);
        expect(flags).toContain(`--meta=${options.metaFile}`);
        expect(flags).toContain("-D");
        expect(flags.filter((f) => f.startsWith("--cg-mem="))).toEqual([`--cg-mem=${options.limits.memoryKb}`]);
        expect(flags).toContain("--extra-time=0.5");
        expect(flags).toContain("--core=0");

        // Directory rules: exactly the fixed set plus this language's own toolchains, read-only.
        const dirs = flags.filter((f) => f.startsWith("--dir="));
        const toolchainRules = dirs.filter((d) => d.startsWith("--dir=/opt/toolchains"));
        // Bare rules: isolate binds them read-only (no ":rw", no "=" remapping).
        expect(toolchainRules).toEqual(toolchainDirs(rt).map((d) => `--dir=${d}`));
        expect(dirs.filter((d) => !d.startsWith("--dir=/opt/toolchains"))).toEqual([
          "--dir=box=./box:rw",
          "--dir=/usr",
          "--dir=/lib",
          "--dir=/lib64:maybe",
          "--dir=/bin",
          "--dir=/etc=/var/lib/recjudge/etc",
          "--dir=/proc=proc:fs",
          "--dir=/dev=/dev:dev:norec",
        ]);
        // No other language's toolchain is ever visible.
        for (const other of LANGUAGE_KEYS) {
          for (const dir of toolchainDirs(LANGUAGE_CATALOG[other])) {
            if (!toolchainDirs(rt).includes(dir)) expect(dirs).not.toContain(`--dir=${dir}`);
          }
        }

        // Environment: exactly the language's variables plus HOME and LANG.
        const env = Object.fromEntries(
          flags.filter((f) => f.startsWith("--env=")).map((f) => {
            const [k, ...v] = f.slice("--env=".length).split("=");
            return [k, v.join("=")];
          }),
        );
        expect(env).toEqual({ ...rt.env, HOME: "/box", LANG: "C.UTF-8" });
        expect(env.PATH).toBe(rt.env.PATH);

        // Limits.
        const value = (name: string) => flags.find((f) => f.startsWith(`--${name}=`))?.split("=")[1];
        expect(Number(value("stack"))).toBeLessThanOrEqual(Number(value("cg-mem")));
        if (role === "compile") {
          const slow = rt.compile?.slow ?? false;
          expect(value("time")).toBe((slow ? LIMITS.compile.cpuSecSlow : LIMITS.compile.cpuSec).toFixed(3));
          expect(value("wall-time")).toBe(String(slow ? LIMITS.compile.wallSecSlow : LIMITS.compile.wallSec));
          expect(value("cg-mem")).toBe("1048576");
          expect(value("processes")).toBe("64");
          expect(value("fsize")).toBe("131072");
          expect(flags.some((f) => f.startsWith("--stdin="))).toBe(false);
        } else {
          expect(value("time")).toBe("2.000");
          expect(value("wall-time")).toBe(String(Math.min(30, Math.ceil(2.5 * 2) + 2)));
          expect(value("cg-mem")).toBe("262144");
          expect(value("stack")).toBe("262144");
          expect(value("processes")).toBe(String(rt.processes));
          expect(value("open-files")).toBe(String(rt.openFiles));
          expect(value("fsize")).toBe(String(LIMITS.outputFile.defaultKb));
          expect(flags).toContain("--stdin=input.txt");
        }
        expect(flags).toContain("--stdout=output.txt");
        expect(flags).toContain("--stderr=error.txt");

        // The program's argv follows "--run --" verbatim.
        expect(argv.slice(argv.indexOf("--run") + 2)).toEqual(options.argv);
      });
    }
  }
});

describe("buildIsolateArgv — box ids and lifecycle", () => {
  it("uses BASE+N / BASE+100+N / BASE+200+N per slot", () => {
    expect(boxIdsForSlot(0, 0)).toEqual({ run: 0, compile: 100, checker: 200 });
    expect(boxIdsForSlot(10, 3)).toEqual({ run: 13, compile: 113, checker: 213 });
  });

  it("builds init and cleanup", () => {
    expect(buildIsolateArgv({ action: "init", boxId: 7 })).toEqual(["--cg", "--box-id=7", "--init"]);
    expect(buildIsolateArgv({ action: "cleanup", boxId: 107 })).toEqual(["--cg", "--box-id=107", "--cleanup"]);
  });

  it("caps wall time at 30 s for the longest CPU limit", () => {
    const rt = LANGUAGE_CATALOG.cpp20;
    const argv = buildIsolateArgv({ ...optionsFor(rt, "run"), limits: runLimits({ timeLimitMs: 15_000, memoryLimitKb: 262_144, language: rt }) });
    expect(argv).toContain("--wall-time=30");
    expect(wallTimeSecFor(1000)).toBe(5);
  });

  it("ignores any attempt to smuggle in extra options", () => {
    const smuggled = { ...optionsFor(LANGUAGE_CATALOG.py312, "run"), shareNet: true, fullEnv: true, mem: 1 } as unknown as IsolateArgvOptions;
    const argv = buildIsolateArgv(smuggled);
    expect(argv.join(" ")).not.toMatch(/share-net|full-env|--mem=/);
  });
});

describe("runArgv — JVM flags", () => {
  it("adds -Xmx / -Xss right after the java program for JVM languages only", () => {
    for (const key of LANGUAGE_KEYS) {
      const rt = LANGUAGE_CATALOG[key];
      const argv = runArgv({ language: rt, memoryLimitKb: 262_144 });
      if (JVM_LANGUAGE_KEYS.includes(key)) {
        expect(argv, key).toEqual([rt.run.argv[0], "-Xmx179m", "-Xss256m", ...rt.run.argv.slice(1)]);
      } else {
        expect(argv, key).toEqual(rt.run.argv);
      }
      expect(argv.join(" ")).not.toContain("share-net");
    }
  });

  it("sizes the flags from the memory limit, clamped to the ceiling", () => {
    expect(jvmRunFlags(262_144)).toEqual(["-Xmx179m", "-Xss256m"]);
    expect(jvmRunFlags(65_536)).toEqual(["-Xmx44m", "-Xss64m"]);
    expect(jvmRunFlags(16 * 1024)).toEqual(["-Xmx32m", "-Xss16m"]);
    expect(jvmRunFlags(1_048_576)).toEqual(["-Xmx716m", "-Xss256m"]);
    const huge = runArgv({ language: LANGUAGE_CATALOG.java21, memoryLimitKb: LIMITS.memory.ceilingKb * 4 });
    expect(huge).toContain(jvmRunFlags(LIMITS.memory.ceilingKb)[0]);
  });

  it("never lets the job change the java program itself", () => {
    const argv = runArgv({ language: LANGUAGE_CATALOG.java21, memoryLimitKb: 262_144 });
    expect(argv[0]).toBe(LANGUAGE_CATALOG.java21.run.argv[0]);
    expect(argv.slice(-3)).toEqual(["-cp", ".", "Main"]);
  });
});

describe("buildIsolateArgv — rejects what it must not run", () => {
  const base = optionsFor(LANGUAGE_CATALOG.cpp20, "run");
  const cases: [string, Partial<Extract<IsolateArgvOptions, { action: "run" }>>][] = [
    ["a traversing toolchain id", { toolchainIds: ["../../etc"] }],
    ["a toolchain id with a slash", { toolchainIds: ["gcc-13.2.0/../x"] }],
    ["a program outside the toolchains", { argv: ["/bin/sh", "-c", "id"] }],
    ["a program in another toolchain", { argv: ["/opt/toolchains/node-22.11.0/bin/node", "x.js"] }],
    ["a dot-dot program path", { argv: ["/opt/toolchains/gcc-13.2.0/../node-22.11.0/bin/node"] }],
    ["a box program with a path", { argv: ["./sub/main"] }],
    ["LD_PRELOAD", { env: { PATH: "/usr/bin", LD_PRELOAD: "/box/x.so" } }],
    ["a lower-case env key", { env: { PATH: "/usr/bin", path: "/x" } }],
    ["no PATH", { env: { HOME: "/box" } }],
    ["an env value with a newline", { env: { PATH: "/usr/bin\n--share-net" } }],
    ["a redirect with a slash", { stdout: "../escape.txt" }],
    ["a relative meta file", { metaFile: "box.meta" }],
    ["memory above the ceiling", { limits: { ...base.limits, memoryKb: 4 * 1024 * 1024 } }],
    ["stack above memory", { limits: { ...base.limits, stackKb: base.limits.memoryKb + 1 } }],
    ["too many processes", { limits: { ...base.limits, processes: 10_000 } }],
    ["a box id out of range", { boxId: 1000 }],
  ];
  for (const [name, patch] of cases) {
    it(`rejects ${name}`, () => {
      expect(() => buildIsolateArgv({ ...base, ...patch })).toThrow(InfraError);
    });
  }
});

/**
 * Phase 12l: one run in the whole judge has no `--stdout` — the solution
 * and the interactor of an interactive pair, whose stdout is a pipe the
 * worker holds. The flags that are never emitted are still never emitted.
 */
describe("an interactive pair's command line", () => {
  const base = optionsFor(LANGUAGE_CATALOG.cpp20, "run");

  it("omits --stdout and --stdin, and keeps --stderr a file in the box", () => {
    const argv = buildIsolateArgv({ ...base, stdin: null, stdout: null });
    expect(argv.some((a) => a.startsWith("--stdout"))).toBe(false);
    expect(argv.some((a) => a.startsWith("--stdin"))).toBe(false);
    expect(argv).toContain(`--stderr=${base.stderr}`);
  });

  it("emits none of the forbidden flags, exactly as every other run does", () => {
    const argv = buildIsolateArgv({ ...base, stdin: null, stdout: null });
    for (const flag of FORBIDDEN_FLAGS) {
      expect(argv.some((a) => flag.test(a)), String(flag)).toBe(false);
    }
  });

  it("still refuses an illegal stderr name", () => {
    expect(() => buildIsolateArgv({ ...base, stdout: null, stderr: "../escape" })).toThrow(InfraError);
  });
});

describe("source guard", () => {
  // Belt and braces next to the argv tests: no source file spells a forbidden
  // isolate option as a string literal anywhere (comments may name them).
  const srcDir = path.resolve(import.meta.dirname, "..", "src");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith(".ts")) files.push(full);
    }
  };
  walk(srcDir);

  it("finds the worker sources", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const literal of ["--share-net", "--full-env", "--inherit-fds", "--special-files", "--tty-hack", "--mem="]) {
    it(`no string literal contains ${literal}`, () => {
      for (const file of files) {
        const text = readFileSync(file, "utf8");
        expect(text, path.relative(srcDir, file)).not.toMatch(new RegExp(`["'\`][^"'\`\\n]*${literal}`));
      }
    });
  }
});
