import { createHash } from "node:crypto";
import { LIMITS } from "@recx/shared";
import type { Db, DbTx } from "@recx/db";
import { blobKey } from "./keys";
import type { TestDataStore } from "./store";

/**
 * Content-addressed test blobs. A blob ≤ LIMITS.inlineBlobBytes of valid
 * UTF-8 text lives inline in TestBlob.inline; anything larger (or binary —
 * a Postgres text column cannot hold NUL or invalid UTF-8) is written to
 * the store at blobs/{sha256} and referenced by TestBlob.storageKey.
 */
export interface PreparedBlob {
  sha256: string;
  sizeBytes: number;
  /** The text to store inline, or null when the blob goes to the store. */
  inline: string | null;
  bytes: Buffer;
}

export function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Decodes as UTF-8 losslessly and contains no NUL byte. */
function isPlainText(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  return Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes);
}

/** Pure: hash, size and the inline decision. */
export function prepareBlob(bytes: Buffer): PreparedBlob {
  const inlinable = bytes.byteLength <= LIMITS.inlineBlobBytes && isPlainText(bytes);
  return {
    sha256: sha256Hex(bytes),
    sizeBytes: bytes.byteLength,
    inline: inlinable ? bytes.toString("utf8") : null,
    bytes,
  };
}

export interface StoredBlob {
  sha256: string;
  sizeBytes: number;
  inline: string | null;
  storageKey: string | null;
}

/** Write a non-inline blob to the store (idempotent: the key is its own hash). */
export async function storeBlob(store: TestDataStore, bytes: Buffer): Promise<StoredBlob> {
  const blob = prepareBlob(bytes);
  if (blob.inline !== null) return { sha256: blob.sha256, sizeBytes: blob.sizeBytes, inline: blob.inline, storageKey: null };
  const storageKey = blobKey(blob.sha256);
  await store.put(storageKey, bytes);
  return { sha256: blob.sha256, sizeBytes: blob.sizeBytes, inline: null, storageKey };
}

export class BlobIntegrityError extends Error {
  constructor(sha256: string, reason: string) {
    super(`TestBlob ${sha256} ${reason}.`);
    this.name = "BlobIntegrityError";
  }
}

/**
 * The bytes of a stored TestBlob (inline text or store key), verified against
 * its sha256 and size — a blob that does not hash to its own name is never
 * used.
 */
export async function readBlobBytes(
  store: Pick<TestDataStore, "get">,
  blob: { sha256: string; sizeBytes: number; inline: string | null; storageKey: string | null },
): Promise<Buffer> {
  let bytes: Buffer;
  if (blob.inline !== null) bytes = Buffer.from(blob.inline, "utf8");
  else if (blob.storageKey) bytes = await store.get(blob.storageKey);
  else throw new BlobIntegrityError(blob.sha256, "has neither inline content nor a storage key");
  if (bytes.byteLength !== blob.sizeBytes) throw new BlobIntegrityError(blob.sha256, "has the wrong size");
  if (sha256Hex(bytes) !== blob.sha256) throw new BlobIntegrityError(blob.sha256, "does not match its sha256");
  return bytes;
}

/**
 * Store a blob and make sure its TestBlob row exists. Rows are never updated:
 * a sha256 that is already registered already points at these exact bytes.
 */
export async function ensureTestBlob(client: Db | DbTx, store: TestDataStore, bytes: Buffer): Promise<StoredBlob> {
  const blob = await storeBlob(store, bytes);
  await client.testBlob.upsert({
    where: { sha256: blob.sha256 },
    create: { sha256: blob.sha256, sizeBytes: blob.sizeBytes, inline: blob.inline, storageKey: blob.storageKey },
    update: {},
  });
  return blob;
}
