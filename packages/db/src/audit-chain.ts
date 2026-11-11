import { createHash } from "node:crypto";

/**
 * Pure helpers for the AuditLog per-UTC-day hash chain. Kept separate from
 * the database code so the chain arithmetic is unit-testable. Shared by
 * apps/web (re-exported from src/lib/audit-chain.ts) and apps/scheduler.
 *
 * hash_n = sha256(hash_{n-1} + "\n" + canonical(entry_n)), with
 * hash_0 = sha256("recx-audit-genesis:" + day). The terminal hash of each day
 * is exported off-box (Phase 10). This makes the log tamper-EVIDENT: a row
 * edited after the fact breaks every later link and the exported terminal.
 * It does not prevent tampering — a database superuser can rewrite a whole
 * day before its terminal hash is exported. Say so wherever it is shown.
 *
 * Metadata rule: ISO strings only, never Date objects. canonicalJson hashes a
 * Date as {} (it has no own enumerable keys), while the jsonb column stores
 * its ISO string, so a Date in metadata makes that row fail verification.
 */
export interface ChainEntry {
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  targetUserId: string | null;
  sensitivity: string;
  metadata: unknown;
  ipHash: string | null;
  chainDay: string;
  createdAt: string;
}

export type ChainRow = ChainEntry & { prevHash: string; hash: string };

export function chainDayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function genesisHash(day: string): string {
  return sha256(`recx-audit-genesis:${day}`);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Deterministic JSON: object keys sorted recursively. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function linkHash(prevHash: string, entry: ChainEntry): string {
  return sha256(`${prevHash}\n${canonicalJson(entry)}`);
}

/** Verify a day's chain in id order. Returns the index of the first bad link, or -1. */
export function verifyChain(day: string, rows: Array<ChainRow>): number {
  let prev = genesisHash(day);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const { prevHash, hash, ...entry } = row;
    if (prevHash !== prev || linkHash(prev, entry) !== hash) return i;
    prev = hash;
  }
  return -1;
}

export interface ChainVerifier {
  /** Feed the next row in id order. Returns false once any link has failed. */
  push(row: ChainRow): boolean;
  /** Rows pushed so far. */
  readonly count: number;
  /** Index of the first bad link, or -1 while the chain is intact. */
  readonly firstBadIndex: number;
  /** The hash of the last row pushed (the genesis hash before any row). */
  readonly terminalHash: string;
}

/**
 * Incremental form of verifyChain for a day read in pages (keyset by id), so
 * a large day never has to sit in memory at once. Agrees with verifyChain on
 * every input (tested).
 */
export function createChainVerifier(day: string): ChainVerifier {
  let prev = genesisHash(day);
  let count = 0;
  let firstBad = -1;
  let terminal = prev;
  return {
    push(row: ChainRow): boolean {
      const index = count++;
      const { prevHash, hash, ...entry } = row;
      terminal = hash;
      if (firstBad !== -1) return false;
      if (prevHash !== prev || linkHash(prev, entry) !== hash) {
        firstBad = index;
        return false;
      }
      prev = hash;
      return true;
    },
    get count() {
      return count;
    },
    get firstBadIndex() {
      return firstBad;
    },
    get terminalHash() {
      return terminal;
    },
  };
}
