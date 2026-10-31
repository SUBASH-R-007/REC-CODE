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
