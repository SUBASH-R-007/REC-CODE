import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bootRefusal } from "../src/boot";

const workerDir = path.resolve(import.meta.dirname, "..");

describe("mock driver in production", () => {
  it("is refused by the boot check", () => {
    expect(bootRefusal({ NODE_ENV: "production", RECX_DRIVER: "mock" })).toMatch(/mock/);
    expect(bootRefusal({ NODE_ENV: "development", RECX_DRIVER: "mock" })).toBeNull();
    expect(bootRefusal({ NODE_ENV: "production", RECX_DRIVER: "isolate" })).toBeNull();
  });

  it("the real entry point exits non-zero before connecting to anything", () => {
    const child = spawnSync(process.execPath, ["--import", "tsx", "src/main.ts"], {
      cwd: workerDir,
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        NODE_ENV: "production",
        RECX_DRIVER: "mock",
        RECX_NODE_ID: "dummy-node",
        RECX_NODE_TOKEN: "dummy-token-0123456789abcdef",
        // Unroutable on purpose: the process must exit before it would try either.
        RECX_APP_URL: "http://127.0.0.1:9",
        REDIS_URL: "redis://127.0.0.1:9",
      },
    });
    expect(child.error).toBeUndefined();
    expect(child.status).not.toBe(0);
    expect(child.status).not.toBeNull();
    expect(child.stderr).toMatch(/RECX_DRIVER=mock/);
    expect(child.stderr).toMatch(/mock judge driver/i);
  });
});
