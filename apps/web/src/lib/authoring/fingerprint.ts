import "server-only";
import { createHash } from "node:crypto";

export interface FingerprintRow {
  index: number;
  isSample: boolean;
  subtaskIndex: number | null;
  points: number | null;
  inputSha256: string;
  outputSha256: string;
}

/**
 * A digest of a revision's test set (order, flags, points, subtask and both
 * blob hashes). publishVersion computes the bundle before its transaction
 * and compares this inside it: a test edit that slipped in between makes
 * the publish a conflict instead of freezing a bundle of other tests.
 */
export function testSetFingerprint(rows: ReadonlyArray<FingerprintRow>): string {
  const hash = createHash("sha256");
  for (const r of [...rows].sort((a, b) => a.index - b.index)) {
    hash.update(
      [r.index, r.isSample ? 1 : 0, r.subtaskIndex ?? "-", r.points ?? "-", r.inputSha256, r.outputSha256].join("|") + "\n",
    );
  }
  return hash.digest("hex");
}
