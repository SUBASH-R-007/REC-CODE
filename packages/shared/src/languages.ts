import { LIMITS } from "./limits";

/**
 * Language catalog. Toolchains are pinned exactly, in both the key/label and
 * the on-disk path /opt/toolchains/<toolchainId>/. A toolchain upgrade is a
 * NEW directory plus a NEW LanguageConfig row — never an in-place change — so
 * a 2026 submission rejudges byte-identically in 2029.
 *
 * At runtime the LanguageConfig rows in the database are authoritative; this
 * catalog is what seeds them and what the worker uses to validate that a
 * job's runtime points inside /opt/toolchains. Compiler and run flags are
 * fixed here, server-side. Students can never inject flags, env vars or
 * extra files.
 */
export const LANGUAGE_KEYS = [
  "c17",
  "cpp17",
  "cpp20",
  "java21",
  "py312",
  "pypy310",
  "node22",
  "go123",
  "kotlin20",
  "rust180",
] as const;

export type LanguageKey = (typeof LANGUAGE_KEYS)[number];

export const TOOLCHAIN_ROOT = "/opt/toolchains";

export interface LanguageRuntime {
  key: LanguageKey;
  /** Shown in the workspace footer and on /judge. */
  label: string;
  toolchainId: string;
  version: string;
  /** Additional read-only toolchains this language needs (Kotlin → JDK). */
  extraToolchainIds: string[];
  sourceFile: string;
  /**
   * Compile step, run in its own box. Null means no compile step at all.
   * For interpreted languages this is a syntax check that maps to CE.
   */
  compile: { argv: string[]; slow: boolean } | null;
  run: { argv: string[] };
  env: Record<string, string>;
  family: "native" | "managed";
  processes: number;
  openFiles: number;
  /** Used only when a problem has no model solution in this language. */
  fallbackMultiplier: number;
  fallbackExtraMs: number;
  /** Monaco / CodeMirror language id. */
  editorLanguage: string;
  /** Phase in which the toolchain image ships; false = not offered yet. */
  enabledByDefault: boolean;
}

const gcc = "gcc-13.2.0";
const cpython = "cpython-3.12.6";
const temurin = "temurin-21.0.4+7";
const rust = "rust-1.80.0";

function tc(id: string, ...rest: string[]) {
  return [TOOLCHAIN_ROOT, id, ...rest].join("/");
}

function basePath(...toolchainIds: string[]) {
  return [...toolchainIds.map((id) => tc(id, "bin")), "/usr/bin", "/bin"].join(":");
}

const nativeLimits = {
  family: "native" as const,
  processes: LIMITS.processes.native,
  openFiles: LIMITS.openFiles.native,
};
const managedLimits = {
  family: "managed" as const,
  processes: LIMITS.processes.managed,
  openFiles: LIMITS.openFiles.managed,
};

export const LANGUAGE_CATALOG: Readonly<Record<LanguageKey, LanguageRuntime>> = {
  c17: {
    key: "c17",
    label: "C17 (GCC 13.2.0)",
    toolchainId: gcc,
    version: "13.2.0",
    extraToolchainIds: [],
    sourceFile: "main.c",
    compile: {
      argv: [tc(gcc, "bin/gcc"), "-std=c17", "-O2", "-pipe", "-static", "-s", "-o", "main", "main.c", "-lm"],
      slow: false,
    },
    run: { argv: ["./main"] },
    env: { PATH: basePath(gcc) },
    ...nativeLimits,
    fallbackMultiplier: 1.0,
    fallbackExtraMs: 0,
    editorLanguage: "c",
    enabledByDefault: false,
  },
  cpp17: {
    key: "cpp17",
    label: "C++17 (GCC 13.2.0)",
    toolchainId: gcc,
    version: "13.2.0",
    extraToolchainIds: [],
    sourceFile: "main.cpp",
    compile: {
      argv: [tc(gcc, "bin/g++"), "-std=c++17", "-O2", "-pipe", "-static", "-s", "-o", "main", "main.cpp"],
      slow: false,
    },
    run: { argv: ["./main"] },
    env: { PATH: basePath(gcc) },
    ...nativeLimits,
    fallbackMultiplier: 1.0,
    fallbackExtraMs: 0,
    editorLanguage: "cpp",
    enabledByDefault: false,
  },
  cpp20: {
    key: "cpp20",
    label: "C++20 (GCC 13.2.0)",
    toolchainId: gcc,
    version: "13.2.0",
    extraToolchainIds: [],
    sourceFile: "main.cpp",
    compile: {
      argv: [tc(gcc, "bin/g++"), "-std=c++20", "-O2", "-pipe", "-static", "-s", "-o", "main", "main.cpp"],
      slow: false,
    },
    run: { argv: ["./main"] },
    env: { PATH: basePath(gcc) },
    ...nativeLimits,
    fallbackMultiplier: 1.0,
    fallbackExtraMs: 0,
    editorLanguage: "cpp",
    enabledByDefault: true,
  },
  java21: {
    key: "java21",
    label: "Java 21 (Temurin 21.0.4+7)",
    toolchainId: temurin,
    version: "21.0.4+7",
    extraToolchainIds: [],
    sourceFile: "Main.java",
    compile: {
      argv: [tc(temurin, "bin/javac"), "-J-XX:+UseSerialGC", "-J-XX:ActiveProcessorCount=1", "-encoding", "UTF-8", "-d", ".", "Main.java"],
      slow: false,
    },
    run: {
      argv: [
        tc(temurin, "bin/java"),
        "-XX:+UseSerialGC",
        "-XX:ActiveProcessorCount=1",
        `-XX:SharedArchiveFile=${tc(temurin, "lib/recx-appcds.jsa")}`,
        "-Xshare:auto",
        "-cp",
        ".",
        "Main",
      ],
    },
    env: { PATH: basePath(temurin), JAVA_HOME: tc(temurin) },
    ...managedLimits,
    fallbackMultiplier: 2.0,
    fallbackExtraMs: 300,
    editorLanguage: "java",
    enabledByDefault: false,
  },
  py312: {
    key: "py312",
    label: "Python 3.12 (CPython 3.12.6, numpy 1.26.4)",
    toolchainId: cpython,
    version: "3.12.6",
    extraToolchainIds: [],
    sourceFile: "main.py",
    compile: {
      // Syntax check only — a SyntaxError is a CE, exactly like a C++ typo.
      argv: [
        tc(cpython, "bin/python3"),
        "-B",
        "-c",
        "import sys;compile(open(sys.argv[1],encoding='utf-8').read(),sys.argv[1],'exec')",
        "main.py",
      ],
      slow: false,
    },
    run: { argv: [tc(cpython, "bin/python3"), "-B", "main.py"] },
    env: {
      PATH: basePath(cpython),
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONHASHSEED: "0",
      PYTHONIOENCODING: "utf-8",
      // numpy's OpenBLAS starts one thread per host CPU; with --processes=1
      // that crashes (SIGSEGV) before main() — pin every BLAS pool to 1.
      OPENBLAS_NUM_THREADS: "1",
      OMP_NUM_THREADS: "1",
    },
    ...nativeLimits,
    fallbackMultiplier: 5.0,
    fallbackExtraMs: 1000,
    editorLanguage: "python",
    enabledByDefault: true,
  },
  pypy310: {
    key: "pypy310",
    label: "PyPy 3.10 (PyPy 7.3.17)",
    toolchainId: "pypy-7.3.17",
    version: "7.3.17",
    extraToolchainIds: [],
    sourceFile: "main.py",
    compile: null,
    run: { argv: [tc("pypy-7.3.17", "bin/pypy3"), "-B", "main.py"] },
    env: { PATH: basePath("pypy-7.3.17"), PYTHONHASHSEED: "0", PYTHONIOENCODING: "utf-8" },
    ...nativeLimits,
    fallbackMultiplier: 2.0,
    fallbackExtraMs: 300,
    editorLanguage: "python",
    enabledByDefault: false,
  },
  node22: {
    key: "node22",
    label: "JavaScript (Node.js 22.11.0)",
    toolchainId: "node-22.11.0",
    version: "22.11.0",
    extraToolchainIds: [],
    sourceFile: "main.js",
    compile: {
      argv: [tc("node-22.11.0", "bin/node"), "--check", "main.js"],
      slow: false,
    },
    run: { argv: [tc("node-22.11.0", "bin/node"), "--stack-size=65500", "main.js"] },
    env: { PATH: basePath("node-22.11.0") },
    ...managedLimits,
    fallbackMultiplier: 2.5,
    fallbackExtraMs: 150,
    editorLanguage: "javascript",
    enabledByDefault: false,
  },
  go123: {
    key: "go123",
    label: "Go 1.23.2",
    toolchainId: "go-1.23.2",
    version: "1.23.2",
    extraToolchainIds: [],
    sourceFile: "main.go",
    compile: {
      // "go build" cannot run in a box (no /tmp, file locks blocked by the
      // syscall filter, a cold cache rebuilds the stdlib at ~7 s CPU).
      // recx-go-build = go tool compile + link against the prebuilt stdlib
      // (infra/judge/toolchains/install-go.sh): ~0.1 s CPU, no cache, no lock.
      argv: [tc("go-1.23.2", "bin/recx-go-build")],
      slow: false,
    },
    run: { argv: ["./main"] },
    env: {
      PATH: basePath("go-1.23.2"),
      GOROOT: tc("go-1.23.2"),
      CGO_ENABLED: "0",
      GOMAXPROCS: "1",
      GOCACHE: "/box/.gocache",
      GOFLAGS: "-mod=mod",
      GO111MODULE: "off",
    },
    ...managedLimits,
    fallbackMultiplier: 1.5,
    fallbackExtraMs: 0,
    editorLanguage: "go",
    enabledByDefault: false,
  },
  kotlin20: {
    key: "kotlin20",
    label: "Kotlin 2.0.21 (JVM 21)",
    toolchainId: "kotlin-2.0.21",
    version: "2.0.21",
    extraToolchainIds: [temurin],
    sourceFile: "Main.kt",
    compile: {
      argv: [tc("kotlin-2.0.21", "bin/kotlinc"), "Main.kt", "-include-runtime", "-d", "main.jar"],
      slow: true,
    },
    run: {
      argv: [tc(temurin, "bin/java"), "-XX:+UseSerialGC", "-XX:ActiveProcessorCount=1", "-jar", "main.jar"],
    },
    env: { PATH: basePath("kotlin-2.0.21", temurin), JAVA_HOME: tc(temurin) },
    ...managedLimits,
    fallbackMultiplier: 2.0,
    fallbackExtraMs: 500,
    editorLanguage: "kotlin",
    enabledByDefault: false,
  },
  /**
   * Rust (Phase 12o), SPEC §11's "rust180".
   *
   * `rustc` alone: no cargo, no crates, no network, no build cache — one
   * file in, one static binary out, which is the only shape that works in
   * a box with no writable home and no file locks (the same reason
   * `install-go.sh` exists).
   *
   * Three flags carry decisions worth stating.
   *
   *   `-C target-feature=+crt-static` makes the binary STATIC, as C and
   *   C++ are with `-static`: a box mounts the toolchain read-only and
   *   nothing else, so a dynamically linked program would have to find
   *   `libc.so.6` somewhere that does not exist.
   *
   *   `-C linker=…/gcc-13.2.0/bin/gcc` is why `gcc-13.2.0` is an extra
   *   toolchain here. rustc does its final link through a C compiler, and
   *   the box has no system one — the same dependency Kotlin has on the
   *   JDK, declared the same way.
   *
   *   `--edition 2021` is pinned because the edition changes what the
   *   SOURCE means, and a submission must mean the same thing in 2029.
   *
   * `-O` is opt-level 2, matching the C and C++ `-O2`. Panics stay
   * unwinding (not `-C panic=abort`) so a student reads the panic message
   * their program actually produced; either way the verdict is RE.
   */
  rust180: {
    key: "rust180",
    label: "Rust 1.80.0",
    toolchainId: rust,
    version: "1.80.0",
    extraToolchainIds: [gcc],
    sourceFile: "main.rs",
    compile: {
      argv: [
        tc(rust, "bin/rustc"),
        "--edition",
        "2021",
        "-O",
        "-C",
        "target-feature=+crt-static",
        "-C",
        `linker=${tc(gcc, "bin/gcc")}`,
        "-C",
        "codegen-units=1",
        // As C and C++ do with `-s`: a judge never reads a core dump, and a
        // stripped binary is a smaller compile artefact to cache and copy.
        // Panic messages keep their line numbers — rustc embeds those as
        // static strings, not as debug info.
        "-C",
        "strip=debuginfo",
        "-o",
        "main",
        "main.rs",
      ],
      // rustc is slower than gcc on one file, and the static link is part of it.
      slow: true,
    },
    run: { argv: ["./main"] },
    /**
     * `TMPDIR=/box` because a box has no /tmp and rustc makes a temporary
     * directory for every compile — the first real verification run failed
     * with "couldn't create a temp dir: No such file or directory", the
     * same class of thing as Go needing `GOCACHE` inside the box.
     */
    env: { PATH: basePath(rust, gcc), TMPDIR: "/box", RUST_BACKTRACE: "0" },
    ...nativeLimits,
    // SPEC §7's table: "C/C++/Rust 1.0".
    fallbackMultiplier: 1.0,
    fallbackExtraMs: 0,
    editorLanguage: "rust",
    enabledByDefault: false,
  },
};

export function isLanguageKey(value: unknown): value is LanguageKey {
  return typeof value === "string" && (LANGUAGE_KEYS as readonly string[]).includes(value);
}

/** Every toolchain directory a language needs, all under TOOLCHAIN_ROOT. */
export function toolchainDirs(rt: Pick<LanguageRuntime, "toolchainId" | "extraToolchainIds">): string[] {
  return [rt.toolchainId, ...rt.extraToolchainIds].map((id) => tc(id));
}

/** The pinned testlib (checker library) toolchain directory. */
export const TESTLIB_ID = "testlib-0.9.41";

/** Toolchain ids must be a plain directory name: no traversal, no slashes. */
export const TOOLCHAIN_ID_PATTERN = /^[a-z][a-z0-9]*-[0-9][0-9A-Za-z.+_-]*$/;

/**
 * Set by the sandbox for every program, after the language's own variables;
 * a language cannot override them (apps/judge-worker/src/sandbox/isolate.ts).
 * Published on /judge.
 */
export const SANDBOX_FORCED_ENV = Object.freeze({ HOME: "/box", LANG: "C.UTF-8" } as const);

/** Languages that run on the JVM (java21, kotlin20): they get the JVM run flags below. */
export const JVM_LANGUAGE_KEYS: readonly LanguageKey[] = ["java21", "kotlin20"];

/**
 * JVM flags the worker inserts after the `java` program for every run of a
 * JVM language, sized from the problem's memory limit (MB = memoryLimitKb /
 * 1024): -Xmx max(32, floor(0.7 × MB)) MB, so the heap fills (and the JVM
 * throws OutOfMemoryError → MLE) before the cgroup kills the process, with
 * the rest left for metaspace, code cache and thread stacks; -Xss min(MB,
 * 256) MB, so deep recursion behaves like the native languages' stack =
 * memory rule. Fixed server-side; students cannot influence them. Published
 * on /judge.
 */
export function jvmRunFlags(memoryLimitKb: number): string[] {
  const mb = Math.max(1, Math.floor(memoryLimitKb / 1024));
  return [`-Xmx${Math.max(32, Math.floor(0.7 * mb))}m`, `-Xss${Math.min(mb, 256)}m`];
}
