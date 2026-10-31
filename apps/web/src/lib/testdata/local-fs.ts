import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, link, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { assertValidKey, ImmutableKeyError, KeyNotFoundError } from "./keys";
import type { TestDataStore } from "./store";

function isErrno(error: unknown, ...codes: string[]): boolean {
  return error instanceof Error && codes.includes((error as NodeJS.ErrnoException).code ?? "");
}

/**
 * Filesystem driver for development and CI. Keys map to files under one root
 * directory; traversal outside the root is impossible by key syntax and is
 * re-checked on the resolved path.
 *
 * Writes are atomic and exclusive: bytes go to a temp file first, then are
 * hard-linked into place (link() fails with EEXIST instead of replacing), so
 * a reader never sees a half-written key and two concurrent writers cannot
 * both win.
 */
export class LocalFsStore implements TestDataStore {
  readonly driver = "local" as const;
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private resolve(key: string): string {
    assertValidKey(key);
    const full = path.resolve(this.root, ...key.split("/"));
    if (!full.startsWith(this.root + path.sep)) throw new Error("Test-data key resolved outside the store root.");
    return full;
  }

  async exists(key: string): Promise<boolean> {
    try {
      return (await stat(this.resolve(key))).isFile();
    } catch (error) {
      if (isErrno(error, "ENOENT", "ENOTDIR")) return false;
      throw error;
    }
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.resolve(key));
    } catch (error) {
      if (isErrno(error, "ENOENT", "ENOTDIR")) throw new KeyNotFoundError(key);
      throw error;
    }
  }

  async stream(key: string): Promise<ReadableStream<Uint8Array>> {
    const file = this.resolve(key);
    if (!(await this.exists(key))) throw new KeyNotFoundError(key);
    return Readable.toWeb(createReadStream(file)) as unknown as ReadableStream<Uint8Array>;
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    const file = this.resolve(key);
    if (await this.exists(key)) return this.assertSame(key, bytes);

    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temp, bytes, { flag: "wx" });
    try {
      try {
        await link(temp, file);
      } catch (error) {
        if (isErrno(error, "EEXIST")) return await this.assertSame(key, bytes);
        if (!isErrno(error, "EPERM", "ENOTSUP", "EXDEV", "ENOSYS")) throw error;
        // Filesystems without hard links: exclusive copy (still never replaces).
        try {
          await copyFile(temp, file, fsConstants.COPYFILE_EXCL);
        } catch (copyError) {
          if (isErrno(copyError, "EEXIST")) return await this.assertSame(key, bytes);
          throw copyError;
        }
      }
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }

  /** Same bytes: idempotent no-op. Different bytes: the key is immutable. */
  private async assertSame(key: string, bytes: Buffer): Promise<void> {
    const existing = await this.get(key);
    if (!existing.equals(bytes)) throw new ImmutableKeyError(key);
  }
}
