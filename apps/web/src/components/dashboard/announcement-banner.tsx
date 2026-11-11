import Link from "next/link";
import { ArrowRight, Megaphone, TriangleAlert } from "lucide-react";
import { Badge, cn } from "@recx/design";
import type { ActiveAnnouncement } from "@/server/queries/announcements";
import { safeNotificationHref } from "@/app/(student)/notifications/model";
import { MarkReadButton } from "@/components/notifications/read-buttons";

/**
 * Live staff announcements on the student dashboard (server component).
 * Each is the viewer's own unread announcement notification; "Dismiss"
 * marks it read, which also clears it from the bell. An important one says
 * "Important" in words and with an icon, never by colour alone. The body is
 * plain text (line breaks kept); a link is followed only if it is a path on
 * this site.
 */
export function AnnouncementBanner({ announcements }: { announcements: ActiveAnnouncement[] }) {
  if (announcements.length === 0) return null;
  return (
    <section role="region" aria-label="Announcements" className="space-y-3">
      {announcements.map((a) => {
        const important = a.tone === "IMPORTANT";
        const href = safeNotificationHref(a.link);
        const Icon = important ? TriangleAlert : Megaphone;
        return (
          <article
            key={a.notificationId}
            aria-labelledby={`announcement-${a.notificationId}`}
            className={cn(
              "flex gap-3 rounded-2xl border px-4 py-3.5 shadow-card sm:px-5",
              important ? "border-warning/30 bg-warning-subtle" : "border-border bg-surface",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl",
                important ? "bg-surface text-text" : "bg-primary-subtle text-primary",
              )}
            >
              <Icon className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                {important ? (
                  <Badge tone="warning">
                    <TriangleAlert className="h-3 w-3" aria-hidden />
                    Important
                  </Badge>
                ) : null}
                <h2 id={`announcement-${a.notificationId}`} className="text-sm font-semibold text-text [overflow-wrap:anywhere]">
                  {a.title}
                </h2>
              </div>
              <p className={cn("mt-1 text-sm whitespace-pre-line [overflow-wrap:anywhere]", important ? "text-text" : "text-text-secondary")}>{a.body}</p>
              {href ? (
                <Link href={href as never} className="mt-1.5 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
                  Open
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                  <span className="sr-only">: {a.title}</span>
                </Link>
              ) : null}
            </div>
            <div className="shrink-0 self-start">
              <MarkReadButton id={a.notificationId} title={a.title} label="Dismiss" />
            </div>
          </article>
        );
      })}
    </section>
  );
}
