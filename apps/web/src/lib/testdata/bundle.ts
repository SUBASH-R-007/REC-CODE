import zlib from "node:zlib";
import { sha256Hex } from "./blobs";
import { bundleKey, manifestKey } from "./keys";
import { getTestDataStore, type TestDataStore } from "./store";
import { writeTar } from "./tar";

/**
 * Per-revision test bundles:
 *
 *   problems/{problemId}/v{revision}/tests.tar.zst   ustar archive, zstd level 19
 *   problems/{problemId}/v{revision}/manifest.json   per-file sha256, size,
 *                                                    subtask, isSample + the
 *                                                    bundle's own sha256
 *
 * Both keys are immutable. Changing a test set publishes revision n+1 under
 * a new prefix; ProblemVersion.manifestSha256 pins the manifest, which in
 * turn pins every file and the archive.
 */
export interface BundleFile {
  /** Path inside the archive, e.g. "tests/000.in". */
  name: string;
  bytes: Buffer;
  testIndex: number;
  role: "input" | "output";
  isSample: boolean;
  subtask: number | null;
}

export interface BundleManifest {
  format: 1;
  problemId: string;
  revision: number;
  bundle: { key: string; sha256: string; sizeBytes: number; compression: "zstd"; level: number };
  files: Array<{
    name: string;
    sha256: string;
    sizeBytes: number;
    testIndex: number;
    role: "input" | "output";
    isSample: boolean;
    subtask: number | null;
  }>;
}

export interface WrittenBundle {
  bundleKey: string;
  manifestKey: string;
  bundleSha256: string;
  manifestSha256: string;
  manifest: BundleManifest;
}

export const BUNDLE_ZSTD_LEVEL = 19;

/** One test's content, as the bundle files are built from it. */
export interface BundleTest {
  index: number;
  isSample: boolean;
  subtask: number | null;
  input: Buffer;
  output: Buffer;
}

/** Pure: tests/NNN.in and tests/NNN.out for every test, in index order. */
export function testBundleFiles(tests: readonly BundleTest[]): BundleFile[] {
  return [...tests]
    .sort((a, b) => a.index - b.index)
    .flatMap((t) => {
      const base = `tests/${String(t.index).padStart(3, "0")}`;
      const common = { testIndex: t.index, isSample: t.isSample, subtask: t.subtask };
      return [
        { name: `${base}.in`, bytes: t.input, role: "input" as const, ...common },
        { name: `${base}.out`, bytes: t.output, role: "output" as const, ...common },
      ];
    });
}

function noZstd(fn: string): Error {
  return new Error(
    `This Node.js runtime (${process.version}) has no zstd support (zlib.${fn}, added in Node 22.15). Test bundles cannot be written.`,
  );
}

const ZSTD_OPTIONS = { params: { [zlib.constants.ZSTD_c_compressionLevel]: BUNDLE_ZSTD_LEVEL } };

/** zstd at the bundle level. Fails clearly on a Node build without zstd (< 22.15). */
export function zstdCompress(bytes: Buffer): Buffer {
  if (typeof zlib.zstdCompressSync !== "function") throw noZstd("zstdCompressSync");
  return zlib.zstdCompressSync(bytes, ZSTD_OPTIONS);
}

/**
 * The same compression on libuv's thread pool: level 19 over a large test
 * set takes seconds, and the web process must not block its event loop.
 */
export function zstdCompressAsync(bytes: Buffer): Promise<Buffer> {
  if (typeof zlib.zstdCompress !== "function") return Promise.reject(noZstd("zstdCompress"));
  return new Promise((resolve, reject) => {
    zlib.zstdCompress(bytes, ZSTD_OPTIONS, (error, result) => (error ? reject(error) : resolve(result)));
  });
}

/**
 * Pure: the manifest for a bundle. Deterministic (no timestamps), so writing
 * the same revision twice yields identical bytes and the second put is a
 * no-op rather than an immutability violation.
 */
export function buildManifest(
  problemId: string,
  revision: number,
  files: readonly BundleFile[],
  bundle: { sha256: string; sizeBytes: number },
): BundleManifest {
  return {
    format: 1,
    problemId,
    revision,
    bundle: {
      key: bundleKey(problemId, revision),
      sha256: bundle.sha256,
      sizeBytes: bundle.sizeBytes,
      compression: "zstd",
      level: BUNDLE_ZSTD_LEVEL,
    },
    files: files.map((f) => ({
      name: f.name,
      sha256: sha256Hex(f.bytes),
      sizeBytes: f.bytes.byteLength,
      testIndex: f.testIndex,
      role: f.role,
      isSample: f.isSample,
      subtask: f.subtask,
    })),
  };
}

/** A bundle computed in memory, not yet written to the store. Deterministic bytes. */
export interface PreparedBundle extends WrittenBundle {
  archive: Buffer;
  manifestBytes: Buffer;
}

/**
 * Compute a revision's bundle and manifest without writing them (zstd runs
 * on the thread pool). Publishing prepares the bundle before its
 * transaction, pins bundleKey and manifestSha256 in the UPDATE that freezes
 * the version, and writes the bytes after the commit (putBundle). Drafts
 * never write bundles.
 */
export async function prepareBundle(input: {
  problemId: string;
  revision: number;
  files: readonly BundleFile[];
}): Promise<PreparedBundle> {
  const archive = await zstdCompressAsync(writeTar(input.files.map((f) => ({ name: f.name, bytes: f.bytes }))));
  const bundleSha256 = sha256Hex(archive);
  const manifest = buildManifest(input.problemId, input.revision, input.files, {
    sha256: bundleSha256,
    sizeBytes: archive.byteLength,
  });
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return {
    bundleKey: bundleKey(input.problemId, input.revision),
    manifestKey: manifestKey(input.problemId, input.revision),
    bundleSha256,
    manifestSha256: sha256Hex(manifestBytes),
    manifest,
    archive,
    manifestBytes,
  };
}

/** Write a prepared bundle. Never overwrites a published key (ImmutableKeyError on different bytes). */
export async function putBundle(prepared: PreparedBundle, store: TestDataStore = getTestDataStore()): Promise<WrittenBundle> {
  // Archive first: a manifest must never point at a bundle that is not there.
  await store.put(prepared.bundleKey, prepared.archive);
  await store.put(prepared.manifestKey, prepared.manifestBytes);
  return {
    bundleKey: prepared.bundleKey,
    manifestKey: prepared.manifestKey,
    bundleSha256: prepared.bundleSha256,
    manifestSha256: prepared.manifestSha256,
    manifest: prepared.manifest,
  };
}

/** Write a revision's bundle and manifest. Never overwrites a published key. */
export async function writeBundle(
  input: { problemId: string; revision: number; files: readonly BundleFile[] },
  store: TestDataStore = getTestDataStore(),
): Promise<WrittenBundle> {
  return putBundle(await prepareBundle(input), store);
}
