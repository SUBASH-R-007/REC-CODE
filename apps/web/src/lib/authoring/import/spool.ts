import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppError } from "@/lib/errors";

/**
 * Stream an upload's body to a private spool file — never buffered in
 * memory — counting bytes and hashing as it goes. Over `maxBytes` the write
 * stops, the partial file is removed and a 413 is thrown. The file is
 * created exclusively ("wx") with mode 0600 in a 0700 directory.
 */

/**
 * The spool directory must be a real directory (not a symlink) owned by this
 * process's user, with no group or other access. mkdir's mode only applies
 * when it creates the directory; on a shared /tmp another account could have
 * created it first and swapped a spooled archive before processing. A
 * directory we own is tightened to 0700; anything else is refused.
 * (POSIX only: Windows has no uid and ignores these mode bits.)
 */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32" || typeof process.getuid !== "function") return;
  const stat = await lstat(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== process.getuid()) {
    console.error(`[import] spool directory ${dir} is not a directory owned by this process; refusing to use it`);
    throw new AppError("The import spool directory is not usable. An operator must fix IMPORT_SPOOL_DIR.", 500);
  }
  if ((stat.mode & 0o077) !== 0) await chmod(dir, 0o700);
}

/** Delete spooled archives older than `olderThanMs` (left by an interrupted import). Never throws. */
export async function sweepSpoolFiles(dir: string, olderThanMs: number, now = Date.now()): Promise<number> {
  let removed = 0;
  try {
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".zip")) continue;
      const file = path.join(dir, name);
      const stat = await lstat(file).catch(() => null);
      if (!stat?.isFile() || now - stat.mtimeMs <= olderThanMs) continue;
      await unlink(file).then(
        () => removed++,
        () => undefined,
      );
    }
  } catch {
    // A missing directory has nothing to sweep.
  }
  return removed;
}
export async function spoolRequestBody(
  req: Request,
  options: { maxBytes: number; dir: string },
): Promise<{ path: string; sizeBytes: number; sha256: string }> {
  if (!req.body) throw new AppError("The upload is empty.", 400);
  await ensurePrivateDir(options.dir);
  const file = path.join(options.dir, `${randomUUID()}.zip`);
  const handle = await open(file, "wx", 0o600);
  const hash = createHash("sha256");
  let size = 0;
  let ok = false;
  const reader = req.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > options.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new AppError(`The archive is larger than ${Math.round(options.maxBytes / 1024 / 1024)} MB.`, 413);
      }
      hash.update(value);
      await handle.write(value);
    }
    if (size === 0) throw new AppError("The upload is empty.", 400);
    ok = true;
    return { path: file, sizeBytes: size, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
    if (!ok) await unlink(file).catch(() => undefined);
  }
}

/** The spool directory: IMPORT_SPOOL_DIR, or <tmp>/recx-imports. */
export function spoolDir(configured: string | undefined): string {
  return configured && configured.trim() ? path.resolve(configured) : path.join(os.tmpdir(), "recx-imports");
}
