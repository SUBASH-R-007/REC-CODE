import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  createChainVerifier,
  genesisHash,
  linkHash,
  verifyChain,
  type ChainEntry,
  type ChainRow,
} from "@/lib/audit-chain";

/**
 * The incremental verifier (used by /super/audit to read a day in pages)
 * agrees with verifyChain, and tampering anywhere is caught. The helpers
 * now live in @recx/db/audit-chain; @/lib/audit-chain re-exports them.
 */

const DAY = "2026-10-10";

function chain(n: number): ChainRow[] {
  const rows: ChainRow[] = [];
  let prev = genesisHash(DAY);
  for (let i = 0; i < n; i++) {
    const entry: ChainEntry = {
      actorId: `u${i}`,
      action: "account.status_changed",
      entityType: "User",
      entityId: `t${i}`,
      targetUserId: `t${i}`,
      sensitivity: i % 2 ? "SECURITY" : "SENSITIVE",
      metadata: { from: "ACTIVE", to: "DISABLED", at: `${DAY}T10:00:0${i % 10}.000Z` },
      ipHash: null,
      chainDay: DAY,
      createdAt: `${DAY}T10:00:0${i % 10}.000Z`,
    };
    const hash = linkHash(prev, entry);
    rows.push({ ...entry, prevHash: prev, hash });
    prev = hash;
  }
  return rows;
}

function runVerifier(rows: ChainRow[]) {
  const v = createChainVerifier(DAY);
  for (const row of rows) v.push(row);
  return v;
}

describe("createChainVerifier", () => {
  it("agrees with verifyChain on an intact chain", () => {
    const rows = chain(25);
    const v = runVerifier(rows);
    expect(verifyChain(DAY, rows)).toBe(-1);
    expect(v.firstBadIndex).toBe(-1);
    expect(v.count).toBe(25);
    expect(v.terminalHash).toBe(rows[24]!.hash);
  });

  it("an empty day ends at its genesis hash", () => {
    const v = createChainVerifier(DAY);
    expect(v.count).toBe(0);
    expect(v.firstBadIndex).toBe(-1);
    expect(v.terminalHash).toBe(genesisHash(DAY));
  });

  it.each([0, 7, 24])("detects tampered metadata at row %i exactly where verifyChain does", (at) => {
    const rows = chain(25);
    rows[at] = { ...rows[at]!, metadata: { from: "ACTIVE", to: "ACTIVE" } };
    expect(runVerifier(rows).firstBadIndex).toBe(at);
    expect(verifyChain(DAY, rows)).toBe(at);
  });

  it("detects a deleted row and a reordered pair", () => {
    const rows = chain(10);
    const deleted = [...rows.slice(0, 4), ...rows.slice(5)];
    expect(runVerifier(deleted).firstBadIndex).toBe(verifyChain(DAY, deleted));
    expect(runVerifier(deleted).firstBadIndex).toBe(4);
    const swapped = [...rows];
    [swapped[2], swapped[3]] = [swapped[3]!, swapped[2]!];
    expect(runVerifier(swapped).firstBadIndex).toBe(2);
  });

  it("a Date in metadata hashes as {} (why audit metadata holds ISO strings only)", () => {
    expect(canonicalJson({ at: new Date("2026-10-10T00:00:00Z") })).toBe('{"at":{}}');
    expect(canonicalJson({ at: "2026-10-10T00:00:00.000Z" })).toBe('{"at":"2026-10-10T00:00:00.000Z"}');
  });
});
