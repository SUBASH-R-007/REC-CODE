import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BlobRef } from "@recx/shared";
import { InfraError } from "./errors";
import type { Logger } from "./logger";

/**
 * Content-addressed blob cache: RECX_CACHE_DIR/<sha256>.
 *
 * Test data is immutable and addressed by its sha256, so a cached blob never
 * goes stale — it is only ever evicted. Every blob is hashed before it is
 * stored (temp file + atomic rename, so a crash never leaves a half-written
 * blob under its final name) and the cache is bounded by an LRU budget
 * (RECX_CACHE_MAX_BYTES). Inline blobs (a custom run's stdin, delivered with
 * the claim) are verified the same way but not stored: they are not TestBlobs
 * and are never asked for twice.
 */

const SHA256_NAME = /^[0-9a-f]{64}$/;
const TEMP_MARKER = ".tmp-";

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Throws InfraError unless data is exactly the blob the ref names. */
export function verifyBlob(ref: BlobRef, data: Buffer): void {
  if (data.byteLength !== ref.sizeBytes) {
    throw new InfraError(`blob ${ref.sha256.slice(0, 12)}… has ${data.byteLength} bytes, expected ${ref.sizeBytes}`);
  }
  const actual = sha256Hex(data);
  if (actual !== ref.sha256) {
    throw new InfraError(`blob sha256 mismatch: expected ${ref.sha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…`);
  }
}

/** An inline blob from the claim, verified against its ref. */
export function verifyInlineBlob(ref: BlobRef, content: string): Buffer {
  const data = Buffer.from(content, "utf8");
  verifyBlob(ref, data);
  return data;
}

export interface BlobCacheOptions {
  dir: string;
  maxBytes: number;
  logger?: Logger;
}

export class BlobCache {
  /** sha → size. Map iteration order is the LRU order: first = least recently used. */
  private readonly entries = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<Buffer>>();
  private totalBytes = 0;
  private ready: Promise<void> | null = null;

  constructor(private readonly options: BlobCacheOptions) {}

  get sizeBytes(): number {
    return this.totalBytes;
  }

  get count(): number {
    return this.entries.size;
  }

  has(sha256: string): boolean {
    return this.entries.has(sha256);
  }

  /** Index what is already on disk (oldest mtime first) and drop leftovers of interrupted writes. */
  init(): Promise<void> {
    this.ready ??= this.scan();
    return this.ready;
  }

  /**
   * The blob's bytes: from disk when cached, otherwise from `fetcher`
   * (verified, then stored). Concurrent requests for one blob share a fetch.
   */
  async get(ref: BlobRef, fetcher: () => Promise<Buffer>): Promise<Buffer> {
    await this.init();
    const cached = await this.readCached(ref);
    if (cached) return cached;

    const pending = this.inflight.get(ref.sha256);
    if (pending) return pending;

    const task = (async () => {
      const data = await fetcher();
      verifyBlob(ref, data);
      await this.store(ref.sha256, data);
      return data;
    })();
    this.inflight.set(ref.sha256, task);
    try {
      return await task;
    } finally {
      this.inflight.delete(ref.sha256);
    }
  }

  private fileFor(sha256: string): string {
    return path.join(this.options.dir, sha256);
  }

  private async scan(): Promise<void> {
    await mkdir(this.options.dir, { recursive: true });
    const found: { sha: string; size: number; mtimeMs: number }[] = [];
    for (const name of await readdir(this.options.dir)) {
      const full = path.join(this.options.dir, name);
      if (name.includes(TEMP_MARKER)) {
        await unlink(full).catch(() => undefined);
        continue;
      }
      if (!SHA256_NAME.test(name)) continue;
      const st = await stat(full).catch(() => null);
      if (st?.isFile()) found.push({ sha: name, size: st.size, mtimeMs: st.mtimeMs });
    }
    found.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const f of found) {
      this.entries.set(f.sha, f.size);
      this.totalBytes += f.size;
    }
    await this.evict(null);
  }

  private async readCached(ref: BlobRef): Promise<Buffer | null> {
    const size = this.entries.get(ref.sha256);
    if (size === undefined) return null;
    try {
      const data = await readFile(this.fileFor(ref.sha256));
      if (data.byteLength === ref.sizeBytes) {
        // Touch: move to the most-recently-used end (and on disk, for the next scan).
        this.entries.delete(ref.sha256);
        this.entries.set(ref.sha256, size);
        const now = new Date();
        await utimes(this.fileFor(ref.sha256), now, now).catch(() => undefined);
        return data;
      }
      this.options.logger?.warn({ sha256: ref.sha256 }, "cached blob has the wrong size; refetching");
    } catch (error) {
      this.options.logger?.warn({ sha256: ref.sha256, err: error }, "cached blob unreadable; refetching");
    }
    await this.remove(ref.sha256);
    return null;
  }

  private async store(sha256: string, data: Buffer): Promise<void> {
    const temp = `${this.fileFor(sha256)}${TEMP_MARKER}${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
      await writeFile(temp, data, { mode: 0o600 });
      await rename(temp, this.fileFor(sha256));
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      // The bytes are verified and in memory: judging can go on without the disk copy.
      this.options.logger?.warn({ sha256, err: error }, "could not write blob to the cache");
      return;
    }
    const previous = this.entries.get(sha256);
    if (previous !== undefined) this.totalBytes -= previous;
    this.entries.delete(sha256);
    this.entries.set(sha256, data.byteLength);
    this.totalBytes += data.byteLength;
    await this.evict(sha256);
  }

  /** Drop least-recently-used blobs until the budget holds. `keep` is evicted last. */
  private async evict(keep: string | null): Promise<void> {
    for (const sha of [...this.entries.keys()]) {
      if (this.totalBytes <= this.options.maxBytes) return;
      if (sha === keep) continue;
      await this.remove(sha);
    }
    if (this.totalBytes > this.options.maxBytes && keep) await this.remove(keep);
  }

  private async remove(sha256: string): Promise<void> {
    const size = this.entries.get(sha256);
    if (size === undefined) return;
    this.entries.delete(sha256);
    this.totalBytes -= size;
    await unlink(this.fileFor(sha256)).catch(() => undefined);
  }
}
