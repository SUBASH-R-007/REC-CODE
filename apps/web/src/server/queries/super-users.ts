import "server-only";
import type { AccountStatus, Prisma, Role, XpEventKind } from "@recx/db";
import { db } from "@/lib/db";
import { ACCOUNT_STATUSES, ROLE_VALUES, type UserFilter } from "@/lib/privileged/payloads";

/**
 * Reads for /super/users (SUPER_ADMIN; the page guards itself). Search is an
 * exact roll-number or email match plus cohort/role/status filters, keyset
 * by collegeId, 50 per page. The XP ledger is LISTED (last 50 events), never
 * summed: totals come from UserStats.
 */

export const USERS_PAGE_SIZE = 50;

export interface UserSearch {
  q?: string;
  role?: Role;
  status?: AccountStatus;
  batchYear?: number;
  departmentCode?: string;
  section?: string;
  after?: string;
}

function one(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  const t = v?.trim();
  return t ? t.slice(0, 120) : undefined;
}

/** Parse the page's searchParams into a validated search (unknown values dropped). */
export function parseUserSearch(params: Record<string, string | string[] | undefined>): UserSearch {
  const role = one(params.role);
  const status = one(params.status);
  const batch = Number(one(params.batch));
  return {
    q: one(params.q),
    role: ROLE_VALUES.includes(role as Role) ? (role as Role) : undefined,
    status: ACCOUNT_STATUSES.includes(status as AccountStatus) ? (status as AccountStatus) : undefined,
    batchYear: Number.isInteger(batch) && batch >= 2000 && batch <= 2100 ? batch : undefined,
    departmentCode: one(params.dept)?.toUpperCase(),
    section: one(params.section)?.toUpperCase(),
    after: one(params.after),
  };
}

/** The same search as a privileged-operation user filter (no free-text query). */
export function searchAsFilter(search: UserSearch): UserFilter | null {
  if (search.q) return null;
  return {
    ...(search.role ? { roles: [search.role] } : {}),
    ...(search.status ? { statuses: [search.status] } : {}),
    ...(search.batchYear !== undefined ? { batchYear: search.batchYear } : {}),
    ...(search.departmentCode ? { departmentCode: search.departmentCode } : {}),
    ...(search.section ? { section: search.section } : {}),
  };
}

export interface UserRow {
  id: string;
  collegeId: string;
  firstName: string;
  lastName: string;
  role: Role;
  status: AccountStatus;
  departmentCode: string | null;
  batchYear: number | null;
  section: string | null;
}

export async function searchUsers(search: UserSearch): Promise<{ rows: UserRow[]; nextAfter: string | null }> {
  const where: Prisma.UserWhereInput = {};
  if (search.q) {
    where.OR = [
      { collegeId: { equals: search.q, mode: "insensitive" } },
      { email: { equals: search.q, mode: "insensitive" } },
    ];
  }
  if (search.role) where.role = search.role;
  if (search.status) where.status = search.status;
  if (search.batchYear !== undefined) where.batchYear = search.batchYear;
  if (search.departmentCode) where.departmentCode = search.departmentCode;
  if (search.section) where.section = search.section;
  if (search.after) where.collegeId = { gt: search.after };
  const rows = await db.user.findMany({
    where,
    orderBy: { collegeId: "asc" },
    take: USERS_PAGE_SIZE + 1,
    select: {
      id: true,
      collegeId: true,
      firstName: true,
      lastName: true,
      role: true,
      status: true,
      departmentCode: true,
      batchYear: true,
      section: true,
    },
  });
  const page = rows.slice(0, USERS_PAGE_SIZE);
  return { rows: page, nextAfter: rows.length > USERS_PAGE_SIZE ? page[page.length - 1]!.collegeId : null };
}

export interface XpEventRow {
  id: string;
  kind: XpEventKind;
  amount: number;
  occurredAt: Date;
  reversesEventId: string | null;
  voided: boolean;
}

/** The last 50 ledger rows of a user, newest first (listed, never summed). */
async function recentXpEvents(userId: string) {
  return db.xpEvent.findMany({
    where: { userId },
    orderBy: { occurredAt: "desc" },
    take: 50,
    select: { id: true, kind: true, amount: true, occurredAt: true, reversesEventId: true },
  });
}

/** Which of these event ids already have a REVERSAL row. */
async function reversedIds(ids: readonly bigint[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db.xpEvent.findMany({
    where: { reversesEventId: { in: [...ids] } },
    select: { reversesEventId: true },
  });
  return new Set(rows.map((r) => String(r.reversesEventId)));
}

export async function loadUserPanel(userId: string) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      collegeId: true,
      firstName: true,
      lastName: true,
      email: true,
      role: true,
      status: true,
      departmentCode: true,
      batchYear: true,
      section: true,
      lastActiveAt: true,
      lastLoginAt: true,
      stats: { select: { xpTotal: true, solvedTotal: true } },
    },
  });
  if (!user) return null;
  const [history, events] = await Promise.all([
    db.auditLog.findMany({
      where: { targetUserId: userId },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: { id: true, action: true, actorId: true, createdAt: true, metadata: true, sensitivity: true },
    }),
    recentXpEvents(userId),
  ]);
  const voided = await reversedIds(events.map((e) => e.id));
  const xp: XpEventRow[] = events.map((e) => ({
    id: e.id.toString(),
    kind: e.kind,
    amount: e.amount,
    occurredAt: e.occurredAt,
    reversesEventId: e.reversesEventId === null ? null : e.reversesEventId.toString(),
    voided: voided.has(e.id.toString()),
  }));
  return {
    user,
    history: history
      .filter((h) => h.action.startsWith("account.") || h.action.startsWith("admin_scope.") || h.action.startsWith("impersonation.") || h.action === "xp.voided")
      .map((h) => ({ ...h, id: h.id.toString() })),
    xp,
  };
}
