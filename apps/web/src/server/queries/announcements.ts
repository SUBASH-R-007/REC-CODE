import "server-only";
import type { AnnouncementTone } from "@recx/db";
import { db } from "@/lib/db";

/**
 * Student side: the dashboard banner. The viewer's OWN announcement
 * notifications that are still unread, whose announcement is live (not
 * archived, not ended). Dismissing marks the notification read, which also
 * clears the bell. Served by the [userId, readAt, createdAt DESC] index.
 */

export interface ActiveAnnouncement {
  notificationId: string;
  title: string;
  body: string;
  link: string | null;
  tone: AnnouncementTone;
  createdAt: Date;
}

export async function getActiveAnnouncements(userId: string, now = new Date()): Promise<ActiveAnnouncement[]> {
  const rows = await db.notification.findMany({
    where: {
      userId,
      readAt: null,
      kind: "announcement",
      announcement: { is: { archivedAt: null, endsAt: { gt: now }, publishedAt: { not: null } } },
    },
    orderBy: { createdAt: "desc" },
    take: 3,
    select: {
      id: true,
      title: true,
      body: true,
      link: true,
      createdAt: true,
      announcement: { select: { tone: true } },
    },
  });
  return rows.map((r) => ({
    notificationId: r.id,
    title: r.title,
    body: r.body,
    link: r.link,
    tone: r.announcement?.tone ?? "INFO",
    createdAt: r.createdAt,
  }));
}
