"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Archive, Send } from "lucide-react";
import { Button, Dialog, useToast } from "@recx/design";
import { archiveAnnouncement, publishAnnouncement } from "@/server/actions/admin-announcements";

/** Publish a draft (after a confirmation naming the audience), or archive a published announcement. */
export function AnnouncementActions({
  id,
  state,
  audienceLabel,
}: {
  id: string;
  state: "draft" | "live" | "ended" | "archived";
  audienceLabel: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();

  if (state === "archived") return null;

  if (state !== "draft") {
    return (
      <Button
        variant="outline"
        loading={pending}
        onClick={() =>
          start(async () => {
            const result = await archiveAnnouncement({ id });
            if (!result.ok) toast(result.error, "error");
            else {
              toast("Archived. The banner is gone; notifications stay in history.", "success");
              router.refresh();
            }
          })
        }
      >
        {!pending && <Archive className="h-4 w-4" aria-hidden />}
        Archive
      </Button>
    );
  }

  return (
    <>
      <Button onClick={() => setConfirming(true)}>
        <Send className="h-4 w-4" aria-hidden />
        Publish
      </Button>
      <Dialog open={confirming} onClose={() => setConfirming(false)} title="Publish this announcement?" size="sm">
        <p className="text-sm text-text-secondary">
          Every current student in <strong className="text-text">{audienceLabel}</strong> gets a notification and a dashboard
          banner now. The text cannot change after publishing.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setConfirming(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            loading={pending}
            onClick={() =>
              start(async () => {
                const result = await publishAnnouncement({ id });
                if (!result.ok) {
                  toast(result.error, "error");
                  return;
                }
                setConfirming(false);
                toast(
                  `Published to ${result.data.recipientCount} ${result.data.recipientCount === 1 ? "student" : "students"}.`,
                  "success",
                );
                router.refresh();
              })
            }
          >
            Publish now
          </Button>
        </div>
      </Dialog>
    </>
  );
}
