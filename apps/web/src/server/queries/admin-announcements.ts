import "server-only";
import type { AnnouncementTone } from "@recx/db";
import { db } from "@/lib/db";
import { scopeCovers, scopedStudentWhere, staffOnlyWhere, type StudentScope } from "@/lib/auth/scope";
import type { Audience } from "@/lib/admin/announcement-audience";

/**
 * Read side of /admin/announcements. An admin sees the announcements whose
 * audience their scope covers (whoever wrote them); read counts come from
 * the fanned-out notifications of students in that scope.
 */

export type AnnouncementState = "draft" | "live" | "ended" | "archived";

export interface AdminAnnouncementRow {
  id: string;
  title: string;
  tone: AnnouncementTone;
  audience: Audience;
  state: AnnouncementState;
  endsAt: Date;
  publishedAt: Date | null;
  createdAt: Date;
  recipientCount: number;
  readInScope: number;
  deliveredInScope: number;
  createdById: string;
}

export interface AdminAnnouncementDetail extends AdminAnnouncementRow {
  body: string;
  link: string | null;
  archivedAt: Date | null;
  authorName: string;
  publisherName: string | null;
}

function stateOf(a: { publishedAt: Date | null; archivedAt: Date | null; endsAt: Date }, now: Date): AnnouncementState {
  if (a.archivedAt) return "archived";
  if (!a.publishedAt) return "draft";
  return a.endsAt > now ? "live" : "ended";
}

const rowSelect = {
  id: true,
  title: true,
  tone: true,
  audienceBatchYear: true,
  audienceDepartmentCode: true,
  audienceSection: true,
  endsAt: true,
  publishedAt: true,
  archivedAt: true,
  createdAt: true,
  recipientCount: true,
  createdById: true,
} as const;

async function readCounts(scope: StudentScope, ids: string[]) {
  if (ids.length === 0) return { read: new Map<string, number>(), delivered: new Map<string, number>() };
  const [read, delivered] = await Promise.all([
    db.notification.groupBy({
      by: ["announcementId"],
      where: { announcementId: { in: ids }, readAt: { not: null }, user: scopedStudentWhere(scope) },
      _count: { _all: true },
    }),
    db.notification.groupBy({
      by: ["announcementId"],
      where: { announcementId: { in: ids }, user: scopedStudentWhere(scope) },
      _count: { _all: true },
    }),
  ]);
  const toMap = (rows: { announcementId: string | null; _count: { _all: number } }[]) =>
    new Map(rows.flatMap((r) => (r.announcementId ? [[r.announcementId, r._count._all] as const] : [])));
  return { read: toMap(read), delivered: toMap(delivered) };
}

type RowRecord = {
  id: string;
  title: string;
  tone: AnnouncementTone;
  audienceBatchYear: number | null;
  audienceDepartmentCode: string | null;
  audienceSection: string | null;
  endsAt: Date;
  publishedAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
  recipientCount: number;
  createdById: string;
};

const audienceOf = (a: RowRecord): Audience => ({
  batchYear: a.audienceBatchYear,
  departmentCode: a.audienceDepartmentCode,
  section: a.audienceSection,
});

const covered = (scope: StudentScope, a: RowRecord) =>
  scopeCovers(scope, { batchYear: a.audienceBatchYear, departmentCode: a.audienceDepartmentCode });

export async function listAnnouncements(scope: StudentScope, now = new Date()): Promise<AdminAnnouncementRow[]> {
  const rows = (
    await db.announcement.findMany({ orderBy: { createdAt: "desc" }, take: 300, select: rowSelect })
  ).filter((a) => covered(scope, a));
  const counts = await readCounts(
    scope,
    rows.map((r) => r.id),
  );
  return rows.slice(0, 100).map((a) => ({
    id: a.id,
    title: a.title,
    tone: a.tone,
    audience: audienceOf(a),
    state: stateOf(a, now),
    endsAt: a.endsAt,
    publishedAt: a.publishedAt,
    createdAt: a.createdAt,
    recipientCount: a.recipientCount,
    readInScope: counts.read.get(a.id) ?? 0,
    deliveredInScope: counts.delivered.get(a.id) ?? 0,
    createdById: a.createdById,
  }));
}

/** One announcement the viewer's scope covers, or null. */
export async function getAnnouncement(
  scope: StudentScope,
  id: string,
  now = new Date(),
): Promise<AdminAnnouncementDetail | null> {
  const a = await db.announcement.findUnique({
    where: { id },
    select: { ...rowSelect, body: true, link: true, publishedById: true },
  });
  if (!a || !covered(scope, a)) return null;
  const staffIds = [a.createdById, a.publishedById].filter((v): v is string => typeof v === "string");
  const [counts, staff] = await Promise.all([
    readCounts(scope, [a.id]),
    db.user.findMany({
      where: staffOnlyWhere({ id: { in: staffIds } }),
      select: { id: true, firstName: true, lastName: true },
    }),
  ]);
  const name = new Map(staff.map((s) => [s.id, `${s.firstName} ${s.lastName}`]));
  return {
    id: a.id,
    title: a.title,
    tone: a.tone,
    audience: audienceOf(a),
    state: stateOf(a, now),
    endsAt: a.endsAt,
    publishedAt: a.publishedAt,
    createdAt: a.createdAt,
    recipientCount: a.recipientCount,
    readInScope: counts.read.get(a.id) ?? 0,
    deliveredInScope: counts.delivered.get(a.id) ?? 0,
    createdById: a.createdById,
    body: a.body,
    link: a.link,
    archivedAt: a.archivedAt,
    authorName: name.get(a.createdById) ?? "Unknown account",
    publisherName: a.publishedById ? (name.get(a.publishedById) ?? "Unknown account") : null,
  };
}
