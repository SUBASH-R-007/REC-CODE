import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppError } from "@/lib/errors";

/**
 * Stream an upload's body to a private spool file — never buffered in
 * memory — counting bytes and hashing as it goes. Over `maxBytes` the write
 * stops, the partial file is removed and a 413 is thrown. The file is
 * created exclusively ("wx") with mode 0600 in a 0700 directory.
 */
export async function spoolRequestBody(
  req: Request,
  options: { maxBytes: number; dir: string },
): Promise<{ path: string; sizeBytes: number; sha256: string }> {
  if (!req.body) throw new AppError("The upload is empty.", 400);
  await mkdir(options.dir, { recursive: true, mode: 0o700 });
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
