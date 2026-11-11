import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { LIMITS } from "@recx/shared";
import { errorMessage } from "./errors";
import type { Logger } from "./logger";
import { BOX_FILE_NAME } from "./sandbox/types";

/**
 * Worker-local compile-artifact cache, shared by Run, Submit and validation
 * jobs on this node, so a Submit after a Run of the same code skips the
 * compiler entirely.
 *
 *   key      sha256 of everything that decides what a compile produces: the
 *            language key, toolchain ids and version, the fixed compile argv
 *            and environment, the source file name and the exact source that
 *            was compiled (the harness-wrapped source in FUNCTION mode).
 *            Checkers use the same cache under their own key (source +
 *            toolchain ids + flags). Toolchain directories are immutable
 *            (an upgrade is a new id), so a key never goes stale for
 *            correctness — the TTL only bounds what is kept.
 *   value    the compile box's output files (binary, class files, checked
 *            source) with their modes, plus the compiler's sanitised
 *            diagnostics and the original compile's CPU ms.
 *   on disk  one file per key: "RECXCC1 <sha256 of the rest>\n", a JSON
 *            header line, then the artefacts' bytes back to back. Written to
 *            a temp name and renamed (a crash never leaves a half entry under
 *            a real name); verified against its sha256 on every read — a
 *            damaged or tampered entry is deleted and treated as a miss.
 *   bounds   LIMITS.compileCache: 1 h TTL from creation, 5 GB budget, least
 *            recently used evicted first.
 *
 * Only successful compiles are cached. A compile error is never cached (a
 * fresh compile repeats it in a second or two, and a node-level fault such as
 * a damaged toolchain must not stick to a source for an hour).
 *
 * A cache that cannot be used (unwritable directory) disables itself: every
 * lookup misses and judging carries on uncached.
 */

const MAGIC = "RECXCC1";
const KEY = /^[0-9a-f]{64}$/;
const TEMP_MARKER = ".tmp-";
/** Same caps as a compile's own collected output (src/judge/run-job.ts). */
const MAX_ENTRY_ARTIFACTS = 512;

export interface CompiledArtifact {
  name: string;
  data: Buffer;
  /** 0o755 (executable) or 0o644. */
  mode: number;
}

export interface CompileCacheEntry {
  /** Sanitised compiler diagnostics (warnings) of the original compile. */
  output: string;
  /** CPU ms of the original compile. */
  timeMs: number;
  artifacts: CompiledArtifact[];
}

const headerSchema = z.object({
  key: z.string().regex(KEY),
  createdAt: z.number().int().nonnegative(),
  output: z.string().max(LIMITS.compile.outputBytes + 256),
  timeMs: z.number().int().nonnegative(),
  artifacts: z
    .array(
      z.object({
        name: z.string().regex(BOX_FILE_NAME).refine((n) => !n.includes("..")),
        mode: z.union([z.literal(0o755), z.literal(0o644)]),
        size: z.number().int().nonnegative(),
      }),
    )
    .max(MAX_ENTRY_ARTIFACTS),
});

/** The cache key for an ordered list of the inputs that decide a compile's output. */
export function compileCacheKey(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(["recx-compile-cache-v1", ...parts])).digest("hex");
}

/**
 * Next to the blob cache: /var/cache/recjudge/blobs → /var/cache/recjudge/compiled;
 * any other blob directory D → D-compiled.
 */
export function defaultCompileCacheDir(blobCacheDir: string): string {
  const resolved = path.resolve(blobCacheDir);
  if (path.basename(resolved) === "blobs") return path.join(path.dirname(resolved), "compiled");
  return `${resolved}-compiled`;
}

export interface CompileCacheOptions {
  dir: string;
  ttlMs?: number;
  budgetBytes?: number;
  logger?: Logger;
  /** Clock (tests). */
  now?: () => number;
}

interface IndexEntry {
  size: number;
  createdAt: number;
}

export class CompileCache {
  /** key → entry. Map iteration order is the LRU order: first = least recently used. */
  private readonly entries = new Map<string, IndexEntry>();
  private totalBytes = 0;
  private ready: Promise<void> | null = null;
  private disabled = false;
  private readonly ttlMs: number;
  private readonly budgetBytes: number;
  private readonly now: () => number;

  constructor(private readonly options: CompileCacheOptions) {
    this.ttlMs = options.ttlMs ?? LIMITS.compileCache.ttlMs;
    this.budgetBytes = options.budgetBytes ?? LIMITS.compileCache.budgetBytes;
    this.now = options.now ?? Date.now;
  }

  get dir(): string {
    return this.options.dir;
  }

  get sizeBytes(): number {
    return this.totalBytes;
  }

  get count(): number {
    return this.entries.size;
  }

  get enabled(): boolean {
    return !this.disabled;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** Index what is on disk (oldest first), drop expired entries and interrupted writes. Never throws. */
  init(): Promise<void> {
    this.ready ??= this.scan().catch((error: unknown) => {
      this.disabled = true;
      this.options.logger?.warn({ dir: this.options.dir, err: errorMessage(error) }, "compile cache unavailable; compiling uncached");
    });
    return this.ready;
  }

  /** The cached compile for `key`, or null (miss, expired, damaged, or the cache is disabled). */
  async get(key: string): Promise<CompileCacheEntry | null> {
    await this.init();
    if (this.disabled || !KEY.test(key)) return null;
    const indexed = this.entries.get(key);
    if (!indexed) return null;
    if (this.now() - indexed.createdAt > this.ttlMs) {
      await this.remove(key);
      return null;
    }
    let entry: CompileCacheEntry | null = null;
    try {
      entry = decode(key, await readFile(this.fileFor(key)), this.now(), this.ttlMs);
    } catch (error) {
      this.options.logger?.warn({ key, err: errorMessage(error) }, "compile cache entry unreadable; compiling again");
    }
    if (!entry) {
      this.options.logger?.warn({ key }, "compile cache entry failed verification or expired; discarded");
      await this.remove(key);
      return null;
    }
    // Touch: most recently used.
    this.entries.delete(key);
    this.entries.set(key, indexed);
    return entry;
  }

  /** Store a successful compile. Failures to write are logged, never thrown: judging goes on. */
  async put(key: string, entry: CompileCacheEntry): Promise<void> {
    await this.init();
    if (this.disabled || !KEY.test(key)) return;
    const createdAt = this.now();
    let bytes: Buffer;
    try {
      bytes = encode(key, entry, createdAt);
    } catch (error) {
      this.options.logger?.warn({ key, err: errorMessage(error) }, "compile result not cacheable");
      return;
    }
    if (bytes.byteLength > this.budgetBytes) return;

    const temp = `${this.fileFor(key)}${TEMP_MARKER}${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
      await writeFile(temp, bytes, { mode: 0o600 });
      await rename(temp, this.fileFor(key));
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      this.options.logger?.warn({ key, err: errorMessage(error) }, "could not write the compile cache entry");
      return;
    }
    const previous = this.entries.get(key);
    if (previous) this.totalBytes -= previous.size;
    this.entries.delete(key);
    this.entries.set(key, { size: bytes.byteLength, createdAt });
    this.totalBytes += bytes.byteLength;
    await this.evict(key);
  }

  private fileFor(key: string): string {
    return path.join(this.options.dir, key);
  }

  private async scan(): Promise<void> {
    await mkdir(this.options.dir, { recursive: true, mode: 0o700 });
    const found: { key: string; size: number; createdAt: number }[] = [];
    const now = this.now();
    for (const name of await readdir(this.options.dir)) {
      const full = path.join(this.options.dir, name);
      if (name.includes(TEMP_MARKER)) {
        await unlink(full).catch(() => undefined);
        continue;
      }
      if (!KEY.test(name)) continue;
      const st = await stat(full).catch(() => null);
      if (!st?.isFile()) continue;
      // The file is written once, at creation: its mtime is the entry's age.
      if (now - st.mtimeMs > this.ttlMs) {
        await unlink(full).catch(() => undefined);
        continue;
      }
      found.push({ key: name, size: st.size, createdAt: st.mtimeMs });
    }
    found.sort((a, b) => a.createdAt - b.createdAt);
    for (const f of found) {
      this.entries.set(f.key, { size: f.size, createdAt: f.createdAt });
      this.totalBytes += f.size;
    }
    await this.evict(null);
  }

  /** Drop least-recently-used entries until the budget holds. `keep` goes last. */
  private async evict(keep: string | null): Promise<void> {
    for (const key of [...this.entries.keys()]) {
      if (this.totalBytes <= this.budgetBytes) return;
      if (key === keep) continue;
      await this.remove(key);
    }
    if (this.totalBytes > this.budgetBytes && keep) await this.remove(keep);
  }

  private async remove(key: string): Promise<void> {
    const indexed = this.entries.get(key);
    if (indexed) {
      this.entries.delete(key);
      this.totalBytes -= indexed.size;
    }
    await unlink(this.fileFor(key)).catch(() => undefined);
  }
}

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function encode(key: string, entry: CompileCacheEntry, createdAt: number): Buffer {
  const header = headerSchema.parse({
    key,
    createdAt: Math.floor(createdAt),
    output: entry.output,
    timeMs: Math.max(0, Math.round(entry.timeMs)),
    artifacts: entry.artifacts.map((a) => ({ name: a.name, mode: a.mode, size: a.data.byteLength })),
  });
  const body = Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`, "utf8"), ...entry.artifacts.map((a) => a.data)]);
  return Buffer.concat([Buffer.from(`${MAGIC} ${sha256Hex(body)}\n`, "latin1"), body]);
}

/** The entry, or null when the bytes are not an intact, unexpired entry for `key`. */
export function decode(key: string, file: Buffer, now: number, ttlMs: number): CompileCacheEntry | null {
  const firstNewline = file.indexOf(0x0a);
  if (firstNewline < 0 || firstNewline > 128) return null;
  const [magic, digest] = file.subarray(0, firstNewline).toString("latin1").split(" ");
  if (magic !== MAGIC || digest === undefined || !KEY.test(digest)) return null;
  const body = file.subarray(firstNewline + 1);
  if (sha256Hex(body) !== digest) return null;

  const headerEnd = body.indexOf(0x0a);
  if (headerEnd < 0) return null;
  let header: z.infer<typeof headerSchema>;
  try {
    const parsed = headerSchema.safeParse(JSON.parse(body.subarray(0, headerEnd).toString("utf8")));
    if (!parsed.success) return null;
    header = parsed.data;
  } catch {
    return null;
  }
  if (header.key !== key || now - header.createdAt > ttlMs) return null;

  const data = body.subarray(headerEnd + 1);
  const total = header.artifacts.reduce((sum, a) => sum + a.size, 0);
  if (total !== data.byteLength) return null;
  const artifacts: CompiledArtifact[] = [];
  let offset = 0;
  for (const a of header.artifacts) {
    artifacts.push({ name: a.name, mode: a.mode, data: Buffer.from(data.subarray(offset, offset + a.size)) });
    offset += a.size;
  }
  return { output: header.output, timeMs: header.timeMs, artifacts };
}
