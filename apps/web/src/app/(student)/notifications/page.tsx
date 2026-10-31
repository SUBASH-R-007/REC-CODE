import type { Metadata } from "next";
import Link from "next/link";
import { Award, Bell, CalendarCheck, Flame, Megaphone, Trophy, type LucideIcon } from "lucide-react";
import { ButtonLink, Card, EmptyState, cn, pluralize } from "@recx/design";
import { requireUser } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { absoluteTime, relativeTime } from "@/components/problems/relative-time";
import { NOTIFICATION_PAGE_SIZE, parseCursor, safeNotificationHref } from "./model";
import { MarkAllReadButton, MarkReadButton } from "@/components/notifications/read-buttons";

export const metadata: Metadata = { title: "Notifications" };

/** Known kinds get their own (decorative) icon; the title always carries the meaning. */
const KIND_ICON: Readonly<Record<string, LucideIcon>> = {
  badge: Award,
  streak: Flame,
  daily: CalendarCheck,
  leaderboard: Trophy,
  announcement: Megaphone,
};

type SearchParams = Promise<{ before?: string | string[] }>;

export default async function NotificationsPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const before = parseCursor((await searchParams).before);

  // The cursor must be one of the viewer's own rows, else start at the top.
  const cursor = before
    ? await db.notification.findFirst({ where: { id: before, userId: user.id }, select: { id: true } })
    : null;

  const [rows, unread] = await Promise.all([
    db.notification.findMany({
      where: { userId: user.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: NOTIFICATION_PAGE_SIZE + 1,
      ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
      select: { id: true, kind: true, title: true, body: true, link: true, readAt: true, createdAt: true },
    }),
    db.notification.count({ where: { userId: user.id, readAt: null } }),
  ]);
  const hasOlder = rows.length > NOTIFICATION_PAGE_SIZE;
  const page = rows.slice(0, NOTIFICATION_PAGE_SIZE);
  const last = page.at(-1);
  const now = new Date();

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Notifications</h1>
          <p className="mt-1 text-sm text-text-secondary">
            {unread === 0 ? "You're all caught up." : `${unread} unread ${pluralize(unread, "notification")}.`}
          </p>
        </div>
        {unread > 0 && <MarkAllReadButton unread={unread} />}
      </div>

      <h2 className="sr-only">{cursor ? "Older notifications" : "Latest notifications"}</h2>
      {page.length === 0 ? (
        <EmptyState
          icon={<Bell className="h-6 w-6" />}
          title={cursor ? "No older notifications" : "No notifications yet"}
          description="Badges, streak milestones and announcements will show up here."
          action={
            cursor ? (
              <ButtonLink href="/notifications" variant="outline">
                Back to the newest
              </ButtonLink>
            ) : undefined
          }
        />
      ) : (
        <Card className="mt-6 overflow-hidden">
          <ul>
            {page.map((n) => {
              const href = safeNotificationHref(n.link);
              const Icon = KIND_ICON[n.kind] ?? Bell;
              const isUnread = n.readAt === null;
              return (
                <li key={n.id} className="border-t border-border first:border-t-0">
                  <article
                    aria-labelledby={`notification-${n.id}`}
                    className={cn("flex gap-3 px-4 py-4 sm:px-5", isUnread && "bg-primary-subtle/40")}
                  >
                    <span
                      aria-hidden
                      className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary-subtle text-primary"
                    >
                      <Icon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2
                          id={`notification-${n.id}`}
                          className={cn("text-sm text-text", isUnread ? "font-semibold" : "font-medium")}
                        >
                          {href ? (
                            <Link href={href as never} className="hover:text-primary hover:underline">
                              {n.title}
                            </Link>
                          ) : (
                            n.title
                          )}
                        </h2>
                        {/* Unread is a word, not just a tint. */}
                        {isUnread && (
                          <span className="inline-flex items-center rounded-full border border-border-strong px-2 py-0.5 text-xs font-semibold text-text">
                            Unread
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-sm whitespace-pre-line text-text-secondary">{n.body}</p>
                      <p className="mt-1.5 text-xs text-text-secondary">
                        <time dateTime={n.createdAt.toISOString()} title={absoluteTime(n.createdAt)}>
                          {relativeTime(n.createdAt, now)}
                        </time>
                      </p>
                    </div>
                    {isUnread && (
                      <div className="shrink-0 self-start">
                        <MarkReadButton id={n.id} title={n.title} />
                      </div>
                    )}
                  </article>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {(hasOlder || cursor) && page.length > 0 && (
        <nav aria-label="Notification pages" className="mt-4 flex flex-wrap justify-between gap-3">
          {cursor ? (
            <ButtonLink href="/notifications" variant="ghost">
              Newest
            </ButtonLink>
          ) : (
            <span />
          )}
          {hasOlder && last && (
            <ButtonLink href={`/notifications?before=${encodeURIComponent(last.id)}`} variant="outline">
              Older notifications
            </ButtonLink>
          )}
        </nav>
      )}
    </div>
  );
}
