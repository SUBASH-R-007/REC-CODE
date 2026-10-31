"use client";

import { History, X } from "lucide-react";
import { Button } from "@recx/design";
import type { RestoreOffer } from "@/hooks/use-drafts";
import { formatSavedAt } from "@/lib/drafts/status";

function message(offer: RestoreOffer): { text: string; action: string } {
  const when = formatSavedAt(offer.updatedAt);
  switch (offer.kind) {
    case "local":
      return {
        text: "A newer copy of your code, saved to your account, was opened. This device has a different version.",
        action: "Restore the version from this device",
      };
    case "server":
      return {
        text: `Your latest code from this device was opened. Your account has a different, older copy${when ? ` (saved ${when})` : ""}.`,
        action: "Restore the version saved to your account",
      };
    case "previous":
      return offer.reason === "reset"
        ? { text: "Your code was reset to the starter code.", action: "Undo reset" }
        : { text: "The other version was restored.", action: "Switch back" };
  }
}

/**
 * The non-blocking draft bar: a newer copy of the code was opened and the
 * other copy differs — offer it back, never discard it silently. After a
 * restore (or a reset) the bar offers the way back. It sits above the
 * editor and never covers code; it stays until dismissed.
 */
export function RestoreBar({
  offer,
  onRestore,
  onDismiss,
}: {
  offer: RestoreOffer;
  onRestore: () => void;
  onDismiss: () => void;
}) {
  const { text, action } = message(offer);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-info/25 bg-info-subtle px-3 py-1.5">
      <History className="h-4 w-4 shrink-0 text-info" aria-hidden />
      <p role="status" className="min-w-0 flex-1 text-xs text-text">
        {text}
      </p>
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" className="h-(--ws-ctl)! text-xs" onClick={onRestore}>
          {action}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-(--ws-ctl)! w-(--ws-ctl)!"
          aria-label="Dismiss this message"
          onClick={onDismiss}
        >
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </div>
    </div>
  );
}
