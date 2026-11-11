import "server-only";
import path from "node:path";
import { env } from "@/lib/env";
import { LocalFsStore } from "./local-fs";
import { S3Store } from "./s3";

/**
 * Where test data lives: content-addressed large blobs (blobs/{sha256}) and
 * per-revision bundles (problems/{problemId}/v{revision}/…). Only apps/web
 * holds store credentials; judge workers receive blobs through
 * /api/judge/blob, authorised per claimed job.
 *
 * Every key is write-once. put() of an existing key with the same bytes is a
 * no-op; with different bytes it throws ImmutableKeyError. Readers may
 * therefore cache by key forever.
 */
export interface TestDataStore {
  readonly driver: "local" | "s3";
  put(key: string, bytes: Buffer): Promise<void>;
  /** Throws KeyNotFoundError when the key does not exist. */
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  /** Streams the bytes of a (possibly large) key without buffering them. */
  stream(key: string): Promise<ReadableStream<Uint8Array>>;
}

const globalForStore = globalThis as unknown as { recxTestDataStore?: TestDataStore };

/** The configured store (TESTDATA_DRIVER), created once per process. */
export function getTestDataStore(): TestDataStore {
  if (globalForStore.recxTestDataStore) return globalForStore.recxTestDataStore;
  const config = env();
  let store: TestDataStore;
  if (config.TESTDATA_DRIVER === "s3") {
    const { S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_REGION } = config;
    if (!S3_ENDPOINT || !S3_BUCKET || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) {
      throw new Error(
        "TESTDATA_DRIVER=s3 needs S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.",
      );
    }
    store = new S3Store({
      endpoint: S3_ENDPOINT,
      region: S3_REGION,
      bucket: S3_BUCKET,
      accessKeyId: S3_ACCESS_KEY_ID,
      secretAccessKey: S3_SECRET_ACCESS_KEY,
    });
  } else {
    // Relative TESTDATA_DIR resolves against the process working directory
    // (apps/web for `next dev`, the seed and the scripts).
    store = new LocalFsStore(path.resolve(process.cwd(), config.TESTDATA_DIR));
  }
  globalForStore.recxTestDataStore = store;
  return store;
}
