import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BlobCache, verifyInlineBlob } from "../src/cache";
import { InfraError } from "../src/errors";
import { blob } from "./support/jobs";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "recjudge-cache-"));
  dirs.push(dir);
  return dir;
}

describe("BlobCache", () => {
  it("stores a verified blob under its sha256 and serves it from disk afterwards", async () => {
    const dir = tempDir();
    const cache = new BlobCache({ dir, maxBytes: 1024 });
    const b = blob("hello\n");
    let fetches = 0;
    const fetcher = async () => {
      fetches++;
      return b.data;
    };
    expect((await cache.get(b.ref, fetcher)).toString()).toBe("hello\n");
    expect((await cache.get(b.ref, fetcher)).toString()).toBe("hello\n");
    expect(fetches).toBe(1);
    expect(readdirSync(dir)).toEqual([b.ref.sha256]);
  });

  it("rejects a blob whose bytes do not match its sha256 and stores nothing", async () => {
    const dir = tempDir();
    const cache = new BlobCache({ dir, maxBytes: 1024 });
    const b = blob("expected\n");
    await expect(cache.get(b.ref, async () => Buffer.from("tampered\n"))).rejects.toThrow(InfraError);
    await expect(cache.get(b.ref, async () => Buffer.from("tampered\n"))).rejects.toThrow(/sha256 mismatch/);
    await expect(cache.get(b.ref, async () => Buffer.from("short"))).rejects.toThrow(/bytes, expected/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("evicts least-recently-used blobs to stay within the budget", async () => {
    const dir = tempDir();
    const cache = new BlobCache({ dir, maxBytes: 25 });
    const a = blob("a".repeat(10));
    const b = blob("b".repeat(10));
    const c = blob("c".repeat(10));
    await cache.get(a.ref, async () => a.data);
    await cache.get(b.ref, async () => b.data);
    await cache.get(a.ref, async () => a.data); // touch a: b is now least recently used
    await cache.get(c.ref, async () => c.data);
    expect(cache.has(a.ref.sha256)).toBe(true);
    expect(cache.has(b.ref.sha256)).toBe(false);
    expect(cache.has(c.ref.sha256)).toBe(true);
    expect(cache.sizeBytes).toBe(20);
    expect(existsSync(path.join(dir, b.ref.sha256))).toBe(false);
  });

  it("still returns a blob larger than the whole budget (it just is not kept)", async () => {
    const cache = new BlobCache({ dir: tempDir(), maxBytes: 4 });
    const big = blob("0123456789");
    expect((await cache.get(big.ref, async () => big.data)).toString()).toBe("0123456789");
    expect(cache.sizeBytes).toBe(0);
  });

  it("shares one fetch between concurrent requests for the same blob", async () => {
    const cache = new BlobCache({ dir: tempDir(), maxBytes: 1024 });
    const b = blob("same\n");
    let fetches = 0;
    const fetcher = async () => {
      fetches++;
      await new Promise((r) => setTimeout(r, 20));
      return b.data;
    };
    await Promise.all([cache.get(b.ref, fetcher), cache.get(b.ref, fetcher), cache.get(b.ref, fetcher)]);
    expect(fetches).toBe(1);
  });

  it("indexes existing blobs at start (oldest first) and removes interrupted temp files", async () => {
    const dir = tempDir();
    const old = blob("old blob!!");
    const fresh = blob("fresh blob");
    writeFileSync(path.join(dir, old.ref.sha256), old.data);
    writeFileSync(path.join(dir, fresh.ref.sha256), fresh.data);
    utimesSync(path.join(dir, old.ref.sha256), new Date(2020, 0, 1), new Date(2020, 0, 1));
    writeFileSync(path.join(dir, `${fresh.ref.sha256}.tmp-123-abcd`), "partial");
    writeFileSync(path.join(dir, "README"), "not a blob");

    const cache = new BlobCache({ dir, maxBytes: 15 });
    await cache.init();
    expect(cache.has(fresh.ref.sha256)).toBe(true);
    expect(cache.has(old.ref.sha256)).toBe(false); // evicted first: older mtime
    expect(readdirSync(dir).sort()).toEqual(["README", fresh.ref.sha256].sort());
  });

  it("refetches a cached blob whose file was damaged", async () => {
    const dir = tempDir();
    const cache = new BlobCache({ dir, maxBytes: 1024 });
    const b = blob("intact\n");
    await cache.get(b.ref, async () => b.data);
    writeFileSync(path.join(dir, b.ref.sha256), "cut");
    let fetches = 0;
    const data = await cache.get(b.ref, async () => {
      fetches++;
      return b.data;
    });
    expect(fetches).toBe(1);
    expect(data.toString()).toBe("intact\n");
  });
});

describe("verifyInlineBlob", () => {
  it("accepts matching content and rejects anything else", () => {
    const b = blob("3 4\n");
    expect(verifyInlineBlob(b.ref, "3 4\n").toString()).toBe("3 4\n");
    expect(() => verifyInlineBlob(b.ref, "3 5\n")).toThrow(/sha256 mismatch/);
  });
});
