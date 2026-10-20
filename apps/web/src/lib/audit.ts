import "server-only";
import { appendAuditEntries, type AuditEntryInput } from "@recx/db/audit";
import { db } from "@/lib/db";

/** One audit row. Metadata: ISO strings only (never Date objects), never secrets, tokens, passwords, emails or disability labels. */
export type AuditInput = AuditEntryInput;

/**
 * Record a sensitive action. Every sensitive mutation calls this. Appends to
 * the per-UTC-day hash chain under an advisory lock so concurrent writers
 * serialise (packages/db/src/audit.ts). Never throws — auditing must not
 * break the underlying operation — but a failure is logged loudly.
 */
export async function audit(entry: AuditInput): Promise<void> {
  try {
    await appendAuditEntries(db, [entry]);
  } catch (error) {
    console.error("[audit] FAILED to record entry", entry.action, error);
  }
}

/**
 * Record several rows as consecutive links in ONE transaction (one advisory
 * lock, one createMany) — e.g. one `account.status_changed` row per user of
 * a bulk change. Never throws, like audit().
 */
export async function auditMany(entries: readonly AuditInput[]): Promise<void> {
  if (entries.length === 0) return;
  try {
    await appendAuditEntries(db, entries);
  } catch (error) {
    console.error("[audit] FAILED to record entries", entries[0]?.action, `(${entries.length} rows)`, error);
  }
}
