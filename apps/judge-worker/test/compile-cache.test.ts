import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LIMITS } from "@recx/shared";
import { CompileCache, compileCacheKey, decode, defaultCompileCacheDir, type CompileCacheEntry } from "../src/compile-cache";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "recjudge-cc-"));
  dirs.push(dir);
  return dir;
}

const HOUR = 60 * 60 * 1000;

function entry(binary: string, output = "main.cpp:3:5: warning: unused variable 'x'"): CompileCacheEntry {
  return {
    output,
    timeMs: 512,
    artifacts: [
      { name: "main", data: Buffer.from(binary), mode: 0o755 },
      { name: "main.py", data: Buffer.from("print(1)\n"), mode: 0o644 },
    ],
  };
}

const key = (n: number) => compileCacheKey(["test", n]);

class Clock {
  t = Date.UTC(2026, 9, 10, 12, 0, 0);
  now = () => this.t;
}

describe("CompileCache", () => {
  it("misses, then serves exactly what was stored (bytes, modes, diagnostics, original compile time)", async () => {
    const cache = new CompileCache({ dir: tempDir() });
    expect(await cache.get(key(1))).toBeNull();
    await cache.put(key(1), entry("\x7fELF binary"));
    const hit = await cache.get(key(1));
    expect(hit).not.toBeNull();
    expect(hit!.output).toBe("main.cpp:3:5: warning: unused variable 'x'");
    expect(hit!.timeMs).toBe(512);
    expect(hit!.artifacts.map((a) => [a.name, a.mode, a.data.toString()])).toEqual([
      ["main", 0o755, "\x7fELF binary"],
      ["main.py", 0o644, "print(1)\n"],
    ]);
    expect(cache.count).toBe(1);
  });

  it("survives a restart: a new instance indexes the directory", async () => {
    const dir = tempDir();
    await new CompileCache({ dir }).put(key(1), entry("bin"));
    const reopened = new CompileCache({ dir });
    await reopened.init();
    expect(reopened.has(key(1))).toBe(true);
    expect((await reopened.get(key(1)))!.artifacts[0]!.data.toString()).toBe("bin");
  });

  it("expires entries 1 h after they were created (LIMITS.compileCache.ttlMs), and deletes them", async () => {
    expect(LIMITS.compileCache.ttlMs).toBe(HOUR);
    const dir = tempDir();
    const clock = new Clock();
    const cache = new CompileCache({ dir, now: clock.now });
    await cache.put(key(1), entry("bin"));
    clock.t += HOUR - 1;
    expect(await cache.get(key(1))).not.toBeNull();
    clock.t += 2;
    expect(await cache.get(key(1))).toBeNull();
    expect(existsSync(path.join(dir, key(1)))).toBe(false);
    expect(cache.count).toBe(0);
  });

  it("drops expired files when indexing at start (by file age)", async () => {
    const dir = tempDir();
    await new CompileCache({ dir }).put(key(1), entry("old"));
    await new CompileCache({ dir }).put(key(2), entry("new"));
    const old = new Date(Date.now() - 2 * HOUR);
    utimesSync(path.join(dir, key(1)), old, old);
    const cache = new CompileCache({ dir });
    await cache.init();
    expect(cache.has(key(1))).toBe(false);
    expect(cache.has(key(2))).toBe(true);
    expect(readdirSync(dir)).toEqual([key(2)]);
  });

  it("evicts least-recently-used entries to stay within its byte budget", async () => {
    const dir = tempDir();
    const probe = new CompileCache({ dir: tempDir() });
    await probe.put(key(9), entry("a".repeat(1000)));
    const one = probe.sizeBytes;
    const cache = new CompileCache({ dir, budgetBytes: Math.floor(one * 2.5) });
    await cache.put(key(1), entry("a".repeat(1000)));
    await cache.put(key(2), entry("b".repeat(1000)));
    await cache.get(key(1)); // touch 1: 2 is now least recently used
    await cache.put(key(3), entry("c".repeat(1000)));
    expect(cache.has(key(1))).toBe(true);
    expect(cache.has(key(2))).toBe(false);
    expect(cache.has(key(3))).toBe(true);
    expect(cache.sizeBytes).toBeLessThanOrEqual(Math.floor(one * 2.5));
    expect(existsSync(path.join(dir, key(2)))).toBe(false);
    expect(LIMITS.compileCache.budgetBytes).toBe(5 * 1024 * 1024 * 1024);
  });

  it("an entry larger than the whole budget is simply not kept", async () => {
    const cache = new CompileCache({ dir: tempDir(), budgetBytes: 100 });
    await cache.put(key(1), entry("x".repeat(1000)));
    expect(cache.count).toBe(0);
    expect(await cache.get(key(1))).toBeNull();
  });

  it.each<[string, (file: Buffer) => Buffer]>([
    ["a flipped byte", (f) => Buffer.from(f.map((b, i) => (i === f.length - 3 ? b ^ 0xff : b)))],
    ["a truncated file", (f) => f.subarray(0, f.length - 5)],
    ["an empty file", () => Buffer.alloc(0)],
    ["garbage", () => Buffer.from("not a cache entry at all\n")],
  ])("%s fails sha256 verification: discarded, a miss, then rewritable", async (_name, damage) => {
    const dir = tempDir();
    const cache = new CompileCache({ dir });
    await cache.put(key(1), entry("intact"));
    const file = path.join(dir, key(1));
    writeFileSync(file, damage(readFileSync(file)));
    expect(await cache.get(key(1))).toBeNull();
    expect(existsSync(file)).toBe(false);
    expect(cache.has(key(1))).toBe(false);
    await cache.put(key(1), entry("again"));
    expect((await cache.get(key(1)))!.artifacts[0]!.data.toString()).toBe("again");
  });

  it("an intact entry stored under another key's name is refused", async () => {
    const dir = tempDir();
    await new CompileCache({ dir }).put(key(1), entry("one"));
    writeFileSync(path.join(dir, key(2)), readFileSync(path.join(dir, key(1))));
    const cache = new CompileCache({ dir });
    expect(await cache.get(key(2))).toBeNull();
    expect((await cache.get(key(1)))!.artifacts[0]!.data.toString()).toBe("one");
  });

  it("decode refuses a correctly hashed entry whose header is not a valid entry (traversing name, odd mode)", () => {
    const sealed = (header: object) => {
      const body = Buffer.from(`${JSON.stringify(header)}\nx`);
      return Buffer.concat([Buffer.from(`RECXCC1 ${createHash("sha256").update(body).digest("hex")}\n`), body]);
    };
    const good = { key: key(1), createdAt: 0, output: "", timeMs: 0, artifacts: [{ name: "x", mode: 0o755, size: 1 }] };
    expect(decode(key(1), sealed(good), 0, HOUR)).not.toBeNull();
    expect(decode(key(1), sealed({ ...good, artifacts: [{ name: "../x", mode: 0o755, size: 1 }] }), 0, HOUR)).toBeNull();
    expect(decode(key(1), sealed({ ...good, artifacts: [{ name: "x", mode: 0o4755, size: 1 }] }), 0, HOUR)).toBeNull();
    expect(decode(key(1), sealed({ ...good, artifacts: [{ name: "x", mode: 0o755, size: 2 }] }), 0, HOUR)).toBeNull();
    expect(decode(key(1), sealed(good), 2 * HOUR, HOUR)).toBeNull();
  });

  it("removes interrupted writes at start and ignores foreign files", async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, `${key(1)}.tmp-123-abcd`), "partial");
    writeFileSync(path.join(dir, "README"), "not an entry");
    const cache = new CompileCache({ dir });
    await cache.init();
    expect(readdirSync(dir)).toEqual(["README"]);
    expect(cache.count).toBe(0);
  });

  it("an unusable directory disables the cache instead of failing jobs", async () => {
    const parent = tempDir();
    writeFileSync(path.join(parent, "file"), "x");
    const cache = new CompileCache({ dir: path.join(parent, "file", "compiled") });
    await cache.init();
    expect(cache.enabled).toBe(false);
    await cache.put(key(1), entry("bin"));
    expect(await cache.get(key(1))).toBeNull();
  });

  it("keys are deterministic and change with any input", () => {
    expect(compileCacheKey(["cpp20", "gcc-13.2.0", "int main(){}"])).toBe(compileCacheKey(["cpp20", "gcc-13.2.0", "int main(){}"]));
    expect(compileCacheKey(["cpp20", "gcc-13.2.0", "int main(){}"])).not.toBe(compileCacheKey(["cpp20", "gcc-13.2.0", "int main(){ }"]));
    expect(compileCacheKey(["a", "bc"])).not.toBe(compileCacheKey(["ab", "c"]));
  });

  it("lives next to the blob cache", () => {
    const base = tempDir();
    expect(defaultCompileCacheDir(path.join(base, "blobs"))).toBe(path.join(base, "compiled"));
    expect(defaultCompileCacheDir(path.join(base, "recjudge-cache"))).toBe(`${path.join(base, "recjudge-cache")}-compiled`);
  });
});
