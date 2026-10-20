"use client";

import { useTransition } from "react";
import { Check, CheckCheck } from "lucide-react";
import { Button, useToast } from "@recx/design";
import { markAllNotificationsRead, markNotificationRead } from "@/server/actions/notifications";

/**
 * "Mark as read" for one notification; the page re-renders via revalidation.
 * The dashboard announcement banner uses it as "Dismiss" (label), which also
 * clears the bell.
 */
export function MarkReadButton({ id, title, label = "Mark as read" }: { id: string; title: string; label?: string }) {
  const [pending, start] = useTransition();
  const { toast } = useToast();
  return (
    <Button
      variant="ghost"
      size="sm"
      loading={pending}
      className="min-h-10"
      onClick={() =>
        start(async () => {
          const result = await markNotificationRead({ id });
          if (!result.ok) toast(result.error, "error");
        })
      }
    >
      {!pending && <Check className="h-4 w-4" aria-hidden />}
      {label}
      <span className="sr-only">: {title}</span>
    </Button>
  );
}

export function MarkAllReadButton({ unread }: { unread: number }) {
  const [pending, start] = useTransition();
  const { toast } = useToast();
  return (
    <Button
      variant="outline"
      loading={pending}
      onClick={() =>
        start(async () => {
          const result = await markAllNotificationsRead();
          if (!result.ok) toast(result.error, "error");
          else toast(`Marked ${result.data.updated} ${result.data.updated === 1 ? "notification" : "notifications"} as read.`, "success");
        })
      }
    >
      {!pending && <CheckCheck className="h-4 w-4" aria-hidden />}
      Mark all as read<span className="sr-only"> ({unread} unread)</span>
    </Button>
  );
}
