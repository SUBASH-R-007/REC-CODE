import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  chainDayOf,
  genesisHash,
  linkHash,
  verifyChain,
  type ChainEntry,
} from "@/lib/audit-chain";

type Row = ChainEntry & { prevHash: string; hash: string };

const DAY = "2026-10-10";

function entry(i: number, overrides: Partial<ChainEntry> = {}): ChainEntry {
  return {
    actorId: `user-${i}`,
    action: i % 2 ? "auth.login" : "auth.login_failed",
    entityType: "User",
    entityId: `user-${i}`,
    targetUserId: null,
    sensitivity: "NORMAL",
    metadata: { attempt: i, nested: { b: 2, a: 1 } },
    ipHash: "ab".repeat(32),
    chainDay: DAY,
    createdAt: `${DAY}T10:00:0${i}.000Z`,
    ...overrides,
  };
}

/** Build a valid chain the way audit() does: each row links to the previous hash. */
function buildChain(entries: ChainEntry[]): Row[] {
  let prev = genesisHash(DAY);
  return entries.map((e) => {
    const hash = linkHash(prev, e);
    const row = { ...e, prevHash: prev, hash };
    prev = hash;
    return row;
  });
}

describe("audit hash chain", () => {
  const rows = buildChain([entry(0), entry(1), entry(2), entry(3)]);

  it("verifies an untouched chain", () => {
    expect(verifyChain(DAY, rows)).toBe(-1);
    expect(verifyChain(DAY, [])).toBe(-1);
  });

  it("detects an edited row at that row", () => {
    const edited = rows.map((r) => ({ ...r }));
    edited[2] = { ...edited[2]!, metadata: { attempt: 99, nested: { a: 1, b: 2 } } };
    expect(verifyChain(DAY, edited)).toBe(2);
  });

  it("detects an edited row even when its own hash is recomputed (the next link breaks)", () => {
    const edited = rows.map((r) => ({ ...r }));
    const forged = { ...edited[1]!, action: "auth.logout" };
    const { prevHash, hash: _hash, ...forgedEntry } = forged;
    edited[1] = { ...forged, hash: linkHash(prevHash, forgedEntry) };
    expect(verifyChain(DAY, edited)).toBe(2);
  });

  it("detects reordered rows", () => {
    const reordered = [rows[0]!, rows[2]!, rows[1]!, rows[3]!];
    expect(verifyChain(DAY, reordered)).toBe(1);
  });

  it("detects a deleted row", () => {
    expect(verifyChain(DAY, [rows[0]!, rows[2]!, rows[3]!])).toBe(1);
  });

  it("anchors each day to its own genesis", () => {
    expect(genesisHash(DAY)).not.toBe(genesisHash("2026-10-11"));
    expect(verifyChain("2026-10-11", rows)).toBe(0);
    expect(chainDayOf(new Date("2026-10-10T23:59:59.999Z"))).toBe(DAY);
  });

  it("hashes metadata canonically (key order does not matter)", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }),
    );
    const prev = genesisHash(DAY);
    expect(linkHash(prev, entry(0, { metadata: { a: 1, b: 2 } }))).toBe(
      linkHash(prev, entry(0, { metadata: { b: 2, a: 1 } })),
    );
  });
});
