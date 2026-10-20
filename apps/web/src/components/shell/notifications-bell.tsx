import Link from "next/link";
import { Bell } from "lucide-react";
import { unreadBadge, unreadLabel } from "@/components/shell/unread";

/**
 * Top-bar bell. Server-rendered from the layout's unread count (no client
 * JS); the notification actions revalidate the layout so it stays current.
 * The count is text, not a coloured dot, and the link's name says it.
 */
export function NotificationsBell({ unread }: { unread: number }) {
  return (
    <Link
      href="/notifications"
      aria-label={unreadLabel(unread)}
      className="relative flex h-10 w-10 items-center justify-center rounded-xl text-text-secondary transition-colors hover:bg-primary-subtle hover:text-text"
    >
      <Bell className="h-5 w-5" aria-hidden />
      {unread > 0 && (
        <span
          aria-hidden
          className="absolute right-0.5 top-0.5 flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-text px-1 text-[0.62rem] font-bold leading-none text-surface ring-2 ring-surface"
        >
          {unreadBadge(unread)}
        </span>
      )}
    </Link>
  );
}
