import { createHash } from "node:crypto";
import type { AccountStatus, Role } from "@recx/db";
import type { RosterRow } from "@recx/shared";
import { scopeCovers, type StudentScope } from "@/lib/auth/scope-where";
import type { ValidatedRosterLine } from "@/lib/admin/roster-csv";

/**
 * The dry run of a roster import: what each line WOULD do. Pure (no I/O):
 * the caller loads the matching accounts and applies the plan.
 *
 * What an import may do: copy an LMS identity that REC Code does not have yet
 * (CREATE), refresh the profile and cohort columns of an existing student
 * (UPDATE), and record the LMS id of a student matched by roll number
 * (link). What it never does: change a role, an account status or a
 * password; touch a staff account; touch anyone outside the importer's
 * scope; or follow a roll-number change (super-admin work). Students missing
 * from the file are left alone.
 */

export const REJECT_REASONS = [
  "INVALID_ROW",
  "MISSING_LMS_ID",
  "DUPLICATE_IN_FILE",
  "KEY_CONFLICT",
  "STAFF_ACCOUNT",
  "OUTSIDE_SCOPE",
  "ROLL_NUMBER_CHANGED",
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export const REJECT_REASON_TEXT: Readonly<Record<RejectReason, string>> = {
  INVALID_ROW: "The row is not valid.",
  MISSING_LMS_ID: "The LMS user id is missing. REC Code only copies people who exist in the LMS.",
  DUPLICATE_IN_FILE: "Another line of the file has the same LMS id, roll number or email.",
  KEY_CONFLICT: "The LMS id, roll number and email point at different accounts. A super-admin must resolve this.",
  STAFF_ACCOUNT: "This matches a staff account, which an import never changes.",
  OUTSIDE_SCOPE: "This student, or the cohort the row moves them to, is outside your scope.",
  ROLL_NUMBER_CHANGED: "The LMS id is known under a different roll number. A super-admin must handle roll-number changes.",
};

/** An existing account that shares a key with some row. `detail` is loaded only for in-scope students. */
export interface ExistingUser {
  id: string;
  role: Role;
  status: AccountStatus;
  lmsUserId: string | null;
  collegeId: string;
  email: string;
  batchYear: number | null;
  departmentCode: string | null;
  updatedAt: Date;
  detail?: { firstName: string; lastName: string; section: string | null };
}

export const CHANGEABLE_FIELDS = ["email", "firstName", "lastName", "batchYear", "departmentCode", "section"] as const;
export type ChangeableField = (typeof CHANGEABLE_FIELDS)[number];

export interface FieldChange {
  field: ChangeableField;
  from: string | number | null;
  to: string | number | null;
}

export type RosterOutcome =
  | { kind: "CREATE"; row: RosterRow }
  | { kind: "UPDATE"; userId: string; updatedAt: string; changes: FieldChange[]; link: boolean; row: RosterRow }
  | { kind: "UNCHANGED"; userId: string; updatedAt: string }
  | { kind: "SKIPPED"; userId: string; updatedAt: string; reason: "ACCOUNT_NOT_ACTIVE" }
  | { kind: "REJECTED"; reason: RejectReason; message: string };

export interface PlannedLine {
  line: number;
  /** From the file, for display (the importer's own data); null for an unreadable row. */
  collegeId: string | null;
  outcome: RosterOutcome;
}

export interface RosterCounts {
  create: number;
  update: number;
  link: number;
  unchanged: number;
  skipped: number;
  rejected: number;
}

export interface RosterPlan {
  lines: PlannedLine[];
  counts: RosterCounts;
}

const CURRENT: ReadonlySet<AccountStatus> = new Set<AccountStatus>(["ACTIVE", "SOFT_RESTRICTED"]);

const lower = (s: string) => s.toLowerCase();

function reject(reason: RejectReason, message?: string): RosterOutcome {
  return { kind: "REJECTED", reason, message: message ?? REJECT_REASON_TEXT[reason] };
}

/** Lines whose LMS id, roll number or email appears on another valid line. */
function duplicateLines(lines: readonly ValidatedRosterLine[]): Set<number> {
  const seen = new Map<string, number[]>();
  for (const l of lines) {
    if (!l.row) continue;
    for (const key of [`l:${l.row.lmsUserId}`, `c:${lower(l.row.collegeId)}`, `e:${lower(l.row.email)}`]) {
      seen.set(key, [...(seen.get(key) ?? []), l.line]);
    }
  }
  const dupes = new Set<number>();
  for (const at of seen.values()) if (at.length > 1) for (const line of at) dupes.add(line);
  return dupes;
}

function changesFor(user: ExistingUser, row: RosterRow): FieldChange[] {
  const detail = user.detail!;
  const current: Record<ChangeableField, string | number | null> = {
    email: user.email,
    firstName: detail.firstName,
    lastName: detail.lastName,
    batchYear: user.batchYear,
    departmentCode: user.departmentCode,
    section: detail.section,
  };
  const changes: FieldChange[] = [];
  for (const field of CHANGEABLE_FIELDS) {
    const from = current[field];
    const to = row[field];
    const differs = field === "email" ? lower(String(from)) !== lower(String(to)) : from !== to;
    if (differs) changes.push({ field, from, to });
  }
  return changes;
}

function planLine(row: RosterRow, matches: readonly ExistingUser[], scope: StudentScope): RosterOutcome {
  const byLms = matches.filter((u) => u.lmsUserId === row.lmsUserId);
  const byCollege = matches.filter((u) => lower(u.collegeId) === lower(row.collegeId));
  const byEmail = matches.filter((u) => lower(u.email) === lower(row.email));
  const ids = new Set([...byLms, ...byCollege, ...byEmail].map((u) => u.id));
  const target = { departmentCode: row.departmentCode, batchYear: row.batchYear };

  if (ids.size === 0) {
    return scopeCovers(scope, target) ? { kind: "CREATE", row } : reject("OUTSIDE_SCOPE");
  }
  if (ids.size > 1) return reject("KEY_CONFLICT");

  const user = (byLms[0] ?? byCollege[0] ?? byEmail[0])!;
  if (user.role !== "STUDENT") return reject("STAFF_ACCOUNT");
  if (user.lmsUserId !== null && user.lmsUserId !== row.lmsUserId) return reject("KEY_CONFLICT");
  if (lower(user.collegeId) !== lower(row.collegeId)) {
    // Same LMS identity under another roll number, or an email shared with
    // a different roll number: never followed by an import.
    return user.lmsUserId === row.lmsUserId ? reject("ROLL_NUMBER_CHANGED") : reject("KEY_CONFLICT");
  }
  // The student now AND the cohort the row moves them to must both be in scope.
  const now = { departmentCode: user.departmentCode, batchYear: user.batchYear };
  if (!user.detail || !scopeCovers(scope, now) || !scopeCovers(scope, target)) return reject("OUTSIDE_SCOPE");
  const updatedAt = user.updatedAt.toISOString();
  if (!CURRENT.has(user.status)) return { kind: "SKIPPED", userId: user.id, updatedAt, reason: "ACCOUNT_NOT_ACTIVE" };

  const changes = changesFor(user, row);
  const link = user.lmsUserId === null;
  if (changes.length === 0 && !link) return { kind: "UNCHANGED", userId: user.id, updatedAt };
  return { kind: "UPDATE", userId: user.id, updatedAt, changes, link, row };
}

export function countOutcomes(lines: readonly PlannedLine[]): RosterCounts {
  const counts: RosterCounts = { create: 0, update: 0, link: 0, unchanged: 0, skipped: 0, rejected: 0 };
  for (const { outcome: o } of lines) {
    if (o.kind === "CREATE") counts.create++;
    else if (o.kind === "UPDATE") {
      if (o.changes.length > 0) counts.update++;
      if (o.link) counts.link++;
    } else if (o.kind === "UNCHANGED") counts.unchanged++;
    else if (o.kind === "SKIPPED") counts.skipped++;
    else counts.rejected++;
  }
  return counts;
}

/**
 * Plan every line against the matching accounts and the importer's scope.
 * Deterministic: the same lines, matches and scope give the same plan.
 */
export function planRosterImport(
  lines: readonly ValidatedRosterLine[],
  matches: readonly ExistingUser[],
  scope: StudentScope,
): RosterPlan {
  const dupes = duplicateLines(lines);
  const planned: PlannedLine[] = [...lines]
    .sort((a, b) => a.line - b.line)
    .map((l): PlannedLine => {
      if (!l.row) return { line: l.line, collegeId: null, outcome: reject(l.error.reason, l.error.message) };
      const outcome = dupes.has(l.line) ? reject("DUPLICATE_IN_FILE") : planLine(l.row, matches, scope);
      return { line: l.line, collegeId: l.row.collegeId, outcome };
    });
  return { lines: planned, counts: countOutcomes(planned) };
}

/**
 * sha256 of the plan in a canonical form (sorted by line; each matched
 * account's updatedAt included). The commit recomputes the plan and refuses
 * unless this hash equals the one the importer was shown.
 */
export function rosterPlanSha256(plan: RosterPlan): string {
  const canonical = [...plan.lines]
    .sort((a, b) => a.line - b.line)
    .map(({ line, outcome: o }) => {
      switch (o.kind) {
        case "CREATE":
          return [line, o.kind, o.row];
        case "UPDATE":
          return [line, o.kind, o.userId, o.updatedAt, o.link, o.changes.map((c) => [c.field, c.from, c.to]), o.row];
        case "UNCHANGED":
          return [line, o.kind, o.userId, o.updatedAt];
        case "SKIPPED":
          return [line, o.kind, o.userId, o.updatedAt, o.reason];
        case "REJECTED":
          return [line, o.kind, o.reason];
      }
    });
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function slugPart(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * A public handle for a new account: "priya-s", then "priya-s-2", "priya-s-3"…
 * Built from the name only, never from the roll number (handles are public).
 */
export function proposeHandle(firstName: string, lastName: string, taken: ReadonlySet<string>): string {
  const first = slugPart(firstName).slice(0, 40) || "student";
  const initial = slugPart(lastName).charAt(0);
  const base = initial ? `${first}-${initial}` : first;
  const takenLower = new Set([...taken].map(lower));
  if (!takenLower.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!takenLower.has(candidate)) return candidate;
  }
}

/** The handle prefix proposeHandle() starts from (to load the taken ones). */
export function handleBase(firstName: string, lastName: string): string {
  return proposeHandle(firstName, lastName, new Set());
}
