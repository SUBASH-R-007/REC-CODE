import { describe, expect, it } from "vitest";
import {
  ConfigError,
  boxIdsForSlot,
  cpuPinningMismatches,
  defaultCacheDir,
  isolateCpuConfigLines,
  maintenanceBoxIds,
  parseConfig,
  parseIsolateCpuConfig,
  workerEnvShape,
} from "../src/config";

const REQUIRED = {
  RECX_NODE_ID: "judge-01",
  RECX_NODE_TOKEN: "abcdefghijklmnopqrstuvwxyz012345",
  RECX_APP_URL: "https://code.example.test/",
  REDIS_URL: "redis://127.0.0.1:6379",
};

describe("worker env schema", () => {
  it("has no database key and no key that could enable sandbox networking", () => {
    const keys = Object.keys(workerEnvShape);
    expect(keys.length).toBeGreaterThan(5);
    for (const key of keys) expect(key).not.toMatch(/DATABASE|NET/i);
  });

  it("applies the documented defaults", () => {
    const config = parseConfig({ ...REQUIRED });
    expect(config).toMatchObject({
      RECX_DRIVER: "isolate",
      RECX_SLOTS: 1,
      RECX_BOX_BASE: 0,
      RECX_CACHE_MAX_BYTES: 40 * 1024 * 1024 * 1024,
      RECX_ISOLATE_BIN: "isolate",
      RECX_SYNTHETIC_ETC: "/var/lib/recjudge/etc",
      RECX_QUEUES: ["judge-practice", "judge-run"],
      RECX_APP_URL: "https://code.example.test",
    });
    expect(config.RECX_CACHE_DIR).toBe(defaultCacheDir());
  });

  it("uses /var/cache/recjudge/blobs on Linux and a temp dir elsewhere", () => {
    expect(defaultCacheDir("linux")).toBe("/var/cache/recjudge/blobs");
    expect(defaultCacheDir("win32")).toMatch(/recjudge-blobs$/);
  });

  it("drops anything that is not part of the schema (a stray DATABASE_URL never reaches the worker)", () => {
    const config = parseConfig({ ...REQUIRED, DATABASE_URL: "postgres://x", AUTH_SECRET: "y" });
    expect(Object.keys(config)).not.toContain("DATABASE_URL");
    expect(Object.keys(config)).not.toContain("AUTH_SECRET");
  });

  it("parses and de-duplicates RECX_QUEUES", () => {
    const config = parseConfig({ ...REQUIRED, RECX_QUEUES: "judge-assessment, judge-run,judge-run" });
    expect(config.RECX_QUEUES).toEqual(["judge-assessment", "judge-run"]);
  });

  it.each([
    ["an unknown queue", { RECX_QUEUES: "judge:practice" }],
    ["an empty queue list", { RECX_QUEUES: " , " }],
    ["an unknown driver", { RECX_DRIVER: "chroot" }],
    ["overlapping box ranges", { RECX_BOX_BASE: "90", RECX_SLOTS: "20" }],
    ["a malformed node id", { RECX_NODE_ID: "judge 01" }],
    ["a short token", { RECX_NODE_TOKEN: "short" }],
    ["a missing app URL", { RECX_APP_URL: "" }],
    ["a non-numeric CPU in RECX_SLOT_CPUS", { RECX_SLOT_CPUS: "2,x" }],
    ["more CPUs than slots", { RECX_SLOTS: "2", RECX_SLOT_CPUS: "2,3,4" }],
    ["a repeated CPU in RECX_SLOT_CPUS", { RECX_SLOTS: "2", RECX_SLOT_CPUS: "2,2" }],
    ["the dev unhardened override in production", { NODE_ENV: "production", RECX_DEV_ALLOW_UNHARDENED_HOST: "1" }],
    ["a self-check box base that collides with job boxes", { RECX_SELFCHECK_BOX_BASE: "200" }],
  ])("rejects %s", (_name, patch) => {
    expect(() => parseConfig({ ...REQUIRED, ...patch })).toThrow(ConfigError);
  });

  it("defaults the Phase 2 knobs to the credential-free, unpinned dev shape", () => {
    const config = parseConfig({ ...REQUIRED });
    expect(config.RECX_SLOT_CPUS).toBeNull();
    expect(config.RECX_DEV_ALLOW_UNHARDENED_HOST).toBe(false);
    expect(config.RECX_SELFCHECK_BOX_BASE).toBe(900);
  });

  it("parses CPU pinning with one core per slot", () => {
    const config = parseConfig({ ...REQUIRED, RECX_SLOTS: "3", RECX_SLOT_CPUS: "2,4,6" });
    expect(config.RECX_SLOT_CPUS).toEqual([2, 4, 6]);
  });

  it("accepts the dev unhardened override only outside production", () => {
    expect(parseConfig({ ...REQUIRED, RECX_DEV_ALLOW_UNHARDENED_HOST: "1" }).RECX_DEV_ALLOW_UNHARDENED_HOST).toBe(true);
  });

  it("has no database key and no key that could enable sandbox networking (including the new ones)", () => {
    for (const key of Object.keys(workerEnvShape)) expect(key).not.toMatch(/DATABASE|NET/i);
  });
});

describe("box id helpers", () => {
  it("keeps maintenance boxes clear of every job box (job ids < 300, maintenance ≥ 300)", () => {
    const maint = maintenanceBoxIds(900);
    expect(maint).toEqual({ run: 900, compile: 901, checker: 902 });
    // Largest job box id on a full node (base 0, 99 slots): 200 + 99 = 299 < 900.
    expect(boxIdsForSlot(0, 99).checker).toBeLessThan(maint.run);
  });
});

describe("CPU pinning config", () => {
  it("generates the isolate per-box cpuset lines slot 0 → cpu[0], etc.", () => {
    const lines = isolateCpuConfigLines(0, [2, 3]);
    expect(lines).toEqual([
      "box0.cpus = 2",
      "box100.cpus = 2",
      "box200.cpus = 2",
      "box1.cpus = 3",
      "box101.cpus = 3",
      "box201.cpus = 3",
    ]);
  });

  it("parses the isolate config and detects a mismatch", () => {
    const good = isolateCpuConfigLines(0, [2, 3]).join("\n");
    expect(cpuPinningMismatches(0, [2, 3], good)).toEqual([]);
    expect(parseIsolateCpuConfig("# comment\nbox0.cpus = 2\nbox100.cpus=2\n").get(0)).toBe("2");

    const wrong = "box0.cpus = 9\n"; // slot 0 pinned to the wrong core, compile/checker missing
    const problems = cpuPinningMismatches(0, [2], wrong);
    expect(problems.length).toBe(3);
    expect(problems[0]).toMatch(/box 0: expected box0\.cpus = 2, found 9/);
  });

  it("matches the install script's spacing (box<id>.cpus = <cpu>)", () => {
    // install-isolate.sh emits "box${box}.cpus = ${cpu}" with spaces around '='.
    const configFromScript = "box0.cpus = 5\nbox100.cpus = 5\nbox200.cpus = 5\n";
    expect(cpuPinningMismatches(0, [5], configFromScript)).toEqual([]);
  });
});
