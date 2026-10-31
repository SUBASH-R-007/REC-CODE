import { describe, expect, it } from "vitest";
import {
  JVM_LANGUAGE_KEYS,
  LANGUAGE_CATALOG,
  LANGUAGE_KEYS,
  TOOLCHAIN_ROOT,
  languageRuntimeSchema,
  toolchainDirs,
  type LanguageKey,
} from "../src/index";

/**
 * The language catalogue against what SPEC says about it.
 *
 * The per-entry invariants (schema, toolchain ids, program paths) are
 * asserted in `protocol.test.ts` for every key. What is here is the part a
 * reviewer would otherwise have to check against SPEC by eye: the fallback
 * multipliers, which decide a problem's time limit in a language with no
 * model solution, and the shape of the two kinds of toolchain dependency.
 */

/** SPEC §7: "C/C++/Rust 1.0; Go 1.5; Java 2.0+300ms; Kotlin 2.0+500ms; C# 2.0+300ms; Node 2.5+150ms; CPython 5.0+1000ms; PyPy 2.0+300ms". */
const SPEC_FALLBACKS: Partial<Record<LanguageKey, { multiplier: number; extraMs: number }>> = {
  c17: { multiplier: 1.0, extraMs: 0 },
  cpp17: { multiplier: 1.0, extraMs: 0 },
  cpp20: { multiplier: 1.0, extraMs: 0 },
  rust180: { multiplier: 1.0, extraMs: 0 },
  go123: { multiplier: 1.5, extraMs: 0 },
  java21: { multiplier: 2.0, extraMs: 300 },
  kotlin20: { multiplier: 2.0, extraMs: 500 },
  cs8: { multiplier: 2.0, extraMs: 300 },
  node22: { multiplier: 2.5, extraMs: 150 },
  py312: { multiplier: 5.0, extraMs: 1000 },
  pypy310: { multiplier: 2.0, extraMs: 300 },
};

describe("the catalogue's fallback limits are SPEC's", () => {
  it("matches every multiplier and extra SPEC states", () => {
    for (const [key, want] of Object.entries(SPEC_FALLBACKS) as [LanguageKey, { multiplier: number; extraMs: number }][]) {
      const rt = LANGUAGE_CATALOG[key];
      expect(rt.fallbackMultiplier, `${key} multiplier`).toBe(want.multiplier);
      expect(rt.fallbackExtraMs, `${key} extra ms`).toBe(want.extraMs);
    }
  });

  it("states one for every language, so no problem has an underived limit", () => {
    for (const key of LANGUAGE_KEYS) {
      expect(Object.keys(SPEC_FALLBACKS), `${key} is missing from SPEC's table above`).toContain(key);
      expect(LANGUAGE_CATALOG[key].fallbackMultiplier).toBeGreaterThan(0);
    }
  });
});

describe("rust180 (Phase 12o)", () => {
  const rust = LANGUAGE_CATALOG.rust180;

  it("is a catalogue language like any other", () => {
    expect(languageRuntimeSchema.safeParse(rust).success).toBe(true);
    expect(LANGUAGE_KEYS).toContain("rust180");
    expect(rust.editorLanguage).toBe("rust");
    // Off until a host installs the toolchain and an admin enables the row.
    expect(rust.enabledByDefault).toBe(false);
  });

  it("compiles one file with rustc and runs the binary: no cargo anywhere", () => {
    const argv = rust.compile?.argv ?? [];
    expect(argv[0]).toBe(`${TOOLCHAIN_ROOT}/rust-1.80.0/bin/rustc`);
    expect(argv.join(" ")).not.toContain("cargo");
    expect(rust.run.argv).toEqual(["./main"]);
    expect(rust.sourceFile).toBe("main.rs");
  });

  it("links statically, because a box has no shared libraries to find", () => {
    const argv = (rust.compile?.argv ?? []).join(" ");
    expect(argv).toContain("target-feature=+crt-static");
    // The same posture as C and C++, which pass -static.
    expect((LANGUAGE_CATALOG.cpp20.compile?.argv ?? []).join(" ")).toContain("-static");
  });

  it("links through gcc, which is why gcc is an extra toolchain", () => {
    const argv = (rust.compile?.argv ?? []).join(" ");
    expect(argv).toContain(`linker=${TOOLCHAIN_ROOT}/gcc-13.2.0/bin/gcc`);
    expect(rust.extraToolchainIds).toEqual(["gcc-13.2.0"]);
    // And every directory it names is a real toolchain directory.
    for (const dir of toolchainDirs(rust)) expect(dir.startsWith(`${TOOLCHAIN_ROOT}/`)).toBe(true);
  });

  it("pins the edition, because an edition changes what the source means", () => {
    const argv = rust.compile?.argv ?? [];
    expect(argv).toContain("--edition");
    expect(argv[argv.indexOf("--edition") + 1]).toBe("2021");
  });

  it("compiles with a temp dir inside the box, because a box has no /tmp", () => {
    // The first real verification run failed with "couldn't create a temp
    // dir": rustc makes one per compile, as Go needs its build cache.
    expect(rust.env.TMPDIR).toBe("/box");
  });

  it("is native, and not one of the JVM languages", () => {
    expect(rust.family).toBe("native");
    expect(JVM_LANGUAGE_KEYS).not.toContain("rust180");
  });
});
describe("cs8 (Phase 12o)", () => {
  const cs = LANGUAGE_CATALOG.cs8;

  it("is a catalogue language like any other", () => {
    expect(languageRuntimeSchema.safeParse(cs).success).toBe(true);
    expect(LANGUAGE_KEYS).toContain("cs8");
    expect(cs.editorLanguage).toBe("csharp");
    // Off until a host installs the toolchain and an admin enables the row.
    expect(cs.enabledByDefault).toBe(false);
  });

  it("names the LANGUAGE version in the key and the RUNTIME in the label", () => {
    // SPEC §11 asked for "cs8" — the C# language version, which the
    // installer's response file pins with -langversion:8.0. The runtime is
    // the current LTS, which the label states so nobody has to guess.
    expect(cs.key).toBe("cs8");
    expect(cs.label).toBe("C# 8 (.NET 10.0.403)");
    expect(cs.version).toBe("10.0.403");
    expect(cs.toolchainId).toBe("dotnet-10.0.403");
  });

  it("compiles through the installer's own script, not MSBuild or NuGet", () => {
    const argv = cs.compile?.argv ?? [];
    expect(argv).toEqual([`${TOOLCHAIN_ROOT}/dotnet-10.0.403/bin/recx-cs-build`]);
    // The same shape as Go's recx-go-build: the project system wants a
    // writable home, a lock file and a network, and a box has none.
    const joined = argv.join(" ");
    expect(joined).not.toContain("msbuild");
    expect(joined).not.toContain("restore");
    expect(joined).not.toContain(" build");
    expect(cs.sourceFile).toBe("main.cs");
  });

  it("runs the compiled assembly on the shared framework", () => {
    expect(cs.run.argv).toEqual([`${TOOLCHAIN_ROOT}/dotnet-10.0.403/dotnet`, "main.dll"]);
    expect(cs.env.DOTNET_ROOT).toBe(`${TOOLCHAIN_ROOT}/dotnet-10.0.403`);
  });

  it("writes only inside the box, and asks the runtime for nothing it cannot have", () => {
    // A box is the only writable place, has no ICU data and no network.
    expect(cs.env.DOTNET_CLI_HOME).toBe("/box");
    expect(cs.env.TMPDIR).toBe("/box");
    expect(cs.env.DOTNET_SYSTEM_GLOBALIZATION_INVARIANT).toBe("1");
    expect(cs.env.DOTNET_CLI_TELEMETRY_OPTOUT).toBe("1");
    // W^X needs a double mapping the sandbox does not grant.
    expect(cs.env.DOTNET_EnableWriteXorExecute).toBe("0");
    // And no diagnostic IPC socket under TMPDIR, which is the box itself.
    expect(cs.env.DOTNET_EnableDiagnostics).toBe("0");
  });

  it("is managed, and gets a managed language's process and fd room", () => {
    expect(cs.family).toBe("managed");
    // A runtime with a thread pool and a GC, like Node and the JVM — but
    // not one of the JVM languages, whose extra toolchain is the JDK.
    expect(JVM_LANGUAGE_KEYS).not.toContain("cs8");
    expect(cs.extraToolchainIds).toEqual([]);
    for (const dir of toolchainDirs(cs)) expect(dir.startsWith(`${TOOLCHAIN_ROOT}/`)).toBe(true);
  });

  it("is slow to compile, so the compile step gets the slow budget", () => {
    // Roslyn on a cold runtime is not a 200 ms affair.
    expect(cs.compile?.slow).toBe(true);
  });
});
