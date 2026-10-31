import { describe, expect, it } from "vitest";
import { readRepoFile, repoFiles } from "./support/repo";

/**
 * A catalogue language and the toolchain that makes it real.
 *
 * Adding a language is a catalogue entry plus an installer, and the fleet is
 * forgiving about the pair being wrong: a node advertises only the languages
 * whose toolchain directory exists AND whose hello-world compiled and ran in
 * the sandbox at boot (docs/OPEN-QUESTIONS.md, Phase 12o). That safety net is
 * why the catalogue can name a directory nobody installs without anybody
 * noticing — the language is simply never offered, on every host, for ever.
 *
 * So these are the two halves a reviewer would otherwise have to check by
 * eye: every toolchain directory the catalogue names is installed by some
 * script under infra/judge/toolchains, and every script there is one that
 * `build-all.sh` actually runs.
 */

const TOOLCHAINS = "infra/judge/toolchains/";
const CATALOG = "packages/shared/src/languages.ts";
const BUILD_ALL = `${TOOLCHAINS}build-all.sh`;

/**
 * Every toolchain directory the catalogue asks a host for: the value of each
 * `toolchainId` and each entry of each `extraToolchainIds`, whether it is a
 * literal (`toolchainId: "pypy-7.3.17"`) or one of the file's own constants
 * (`const gcc = "gcc-13.2.0"` and then `toolchainId: gcc`).
 */
function catalogToolchainIds(): string[] {
  const source = readRepoFile(CATALOG);
  const constants = new Map(
    [...source.matchAll(/^const ([A-Za-z][A-Za-z0-9]*) = "([^"]+)";$/gm)].map((m) => [m[1]!, m[2]!]),
  );
  const ids = new Set<string>();
  const add = (token: string) => {
    const t = token.trim();
    if (!t) return;
    const literal = /^"([^"]+)"$/.exec(t);
    const id = literal ? literal[1]! : constants.get(t);
    expect(id, `${CATALOG} names a toolchain as ${t}, which is neither a literal nor a constant in that file`)
      .toBeDefined();
    ids.add(id!);
  };
  for (const m of source.matchAll(/\btoolchainId: ([^,\n]+),/g)) add(m[1]!);
  for (const m of source.matchAll(/\bextraToolchainIds: \[([^\]]*)\]/g)) {
    for (const token of m[1]!.split(",")) add(token);
  }
  return [...ids].sort();
}

function installerScripts(): string[] {
  return repoFiles()
    .filter((rel) => rel.startsWith(TOOLCHAINS) && /\/(install|build)-[a-z0-9-]+\.sh$/.test(rel))
    .filter((rel) => !rel.endsWith("build-all.sh"))
    .sort();
}

describe("the catalogue's toolchains and the scripts that install them", () => {
  it("finds the catalogue's toolchain ids at all", () => {
    // If this ever reads zero, the two tests below are vacuously green.
    // Fewer directories than languages: c17, cpp17 and cpp20 share gcc, and
    // kotlin20 runs on the JDK temurin installs for java21.
    const ids = catalogToolchainIds();
    expect(ids.length).toBeGreaterThanOrEqual(9);
    expect(ids).toContain("gcc-13.2.0");
    expect(ids).toContain("dotnet-10.0.403");
  });

  it("installs every toolchain directory the catalogue names", () => {
    const scripts = installerScripts();
    expect(scripts.length).toBeGreaterThanOrEqual(10);
    const sources = scripts.map((rel) => readRepoFile(rel));
    for (const id of catalogToolchainIds()) {
      const installs = scripts.filter((_, i) => sources[i]!.includes(id));
      expect(
        installs,
        `no script under ${TOOLCHAINS} installs /opt/toolchains/${id}, which ${CATALOG} names: ` +
          "a node would never advertise that language, on any host",
      ).not.toEqual([]);
    }
  });

  it("runs every installer from build-all.sh", () => {
    const buildAll = readRepoFile(BUILD_ALL);
    const steps = /\nSTEPS=\(([^)]*)\)/.exec(buildAll)?.[1]?.trim().split(/\s+/) ?? [];
    const named = new Map(
      [...buildAll.matchAll(/^ {2}\[([a-z0-9-]+)\]=([a-z0-9-]+\.sh)$/gm)].map((m) => [m[1]!, m[2]!]),
    );
    expect(steps.length).toBeGreaterThanOrEqual(10);
    expect([...named.keys()].sort()).toEqual([...steps].sort());

    const scriptsRun = new Set(named.values());
    for (const rel of installerScripts()) {
      const base = rel.slice(TOOLCHAINS.length);
      expect(
        scriptsRun.has(base),
        `${rel} exists but build-all.sh never runs it: a fresh judge host would not get that toolchain`,
      ).toBe(true);
    }
    for (const [step, script] of named) {
      expect(repoFiles(), `build-all.sh step '${step}' names a script that is not in the repository`).toContain(
        `${TOOLCHAINS}${script}`,
      );
    }
  });
});

describe("a language key is a promise about the language, not the runtime", () => {
  it("pins C# to language version 8, which is what the key cs8 says", () => {
    // The DIRECTORY is .NET 10 (the current LTS; .NET 8 leaves support on
    // 2026-11-10), so nothing but the compiler flag keeps `cs8` honest.
    const installer = readRepoFile(`${TOOLCHAINS}install-dotnet.sh`);
    expect(installer).toContain("-langversion:8.0");
    expect(readRepoFile(CATALOG)).toContain('key: "cs8"');
  });

  it("pins Rust to the 2021 edition, because an edition changes the source's meaning", () => {
    expect(readRepoFile(CATALOG)).toMatch(/"--edition",\s*"2021",/);
  });
});
