/**
 * Storage-key rules shared by every TestDataStore driver. Pure (no I/O) so
 * the local and S3 drivers — and their tests — agree on exactly which keys
 * exist.
 *
 * Keys are immutable: once a key holds bytes it holds those bytes forever.
 * A changed test set is a new problem revision (v{n+1}), never an overwrite.
 */

/** Segments start with a letter or digit, so "." and ".." can never appear. */
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const MAX_KEY_LENGTH = 512;

export class InvalidKeyError extends Error {
  constructor(key: string) {
    super(`Invalid test-data key ${JSON.stringify(key.slice(0, 80))}.`);
    this.name = "InvalidKeyError";
  }
}

/** put() of an existing key with different bytes. Published data is never rewritten. */
export class ImmutableKeyError extends Error {
  constructor(key: string) {
    super(`Test-data key ${key} already holds different bytes. Published keys are immutable; write a new revision instead.`);
    this.name = "ImmutableKeyError";
  }
}

export class KeyNotFoundError extends Error {
  constructor(key: string) {
    super(`Test-data key ${key} does not exist.`);
    this.name = "KeyNotFoundError";
  }
}

export function isValidKey(key: string): boolean {
  return key.length > 0 && key.length <= MAX_KEY_LENGTH && KEY_PATTERN.test(key);
}

export function assertValidKey(key: string): void {
  if (!isValidKey(key)) throw new InvalidKeyError(key);
}

/** Content-addressed location of a large TestBlob. */
export function blobKey(sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new InvalidKeyError(`blobs/${sha256}`);
  return `blobs/${sha256}`;
}

function assertProblemRef(problemId: string, revision: number) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(problemId)) throw new InvalidKeyError(`problems/${problemId}`);
  if (!Number.isInteger(revision) || revision < 1) {
    throw new InvalidKeyError(`problems/${problemId}/v${revision}`);
  }
}

/** problems/{problemId}/v{revision}/tests.tar.zst */
export function bundleKey(problemId: string, revision: number): string {
  assertProblemRef(problemId, revision);
  return `problems/${problemId}/v${revision}/tests.tar.zst`;
}

/** problems/{problemId}/v{revision}/manifest.json */
export function manifestKey(problemId: string, revision: number): string {
  assertProblemRef(problemId, revision);
  return `problems/${problemId}/v${revision}/manifest.json`;
}
