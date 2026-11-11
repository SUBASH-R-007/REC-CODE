"use client";

import { useOptimistic, useState, useTransition } from "react";
import { Bookmark } from "lucide-react";
import { cn, useToast } from "@recx/design";
import { toggleBookmark } from "@/server/actions/bookmarks";

/**
 * Bookmark toggle (problem list rows and the workspace header). A toggle
 * button: the accessible name stays the same and aria-pressed carries the
 * state; visually the icon is filled when bookmarked and outlined when not,
 * so the state never rests on colour alone.
 *
 * Optimistic: the icon flips at once and the server action runs in a
 * transition. The action receives the desired state, so rapid clicks
 * converge on the last one. On failure the button falls back to the last
 * confirmed state and a toast explains why. Success is silent — the pressed
 * state is already announced by screen readers.
 */
export function BookmarkButton({
  problemId,
  bookmarked,
  label,
  className,
}: {
  problemId: string;
  bookmarked: boolean;
  /** What is being bookmarked, for the accessible name — e.g. the problem title. */
  label?: string;
  className?: string;
}) {
  const [confirmed, setConfirmed] = useState({ from: bookmarked, value: bookmarked });
  // A fresh server render (new prop) wins over local state.
  if (confirmed.from !== bookmarked) setConfirmed({ from: bookmarked, value: bookmarked });

  const [optimistic, setOptimistic] = useOptimistic(confirmed.value);
  const [, startTransition] = useTransition();
  const { toast } = useToast();

  function onClick() {
    const next = !optimistic;
    startTransition(async () => {
      setOptimistic(next);
      const result = await toggleBookmark({ problemId, bookmarked: next });
      if (result.ok) {
        setConfirmed((prev) => ({ ...prev, value: result.data.bookmarked }));
      } else {
        toast(result.error, "error");
      }
    });
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={optimistic}
      aria-label={label ? `Bookmark ${label}` : "Bookmark this problem"}
      className={cn(
        "inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl border transition-colors",
        optimistic
          ? "border-primary/40 bg-primary-subtle text-primary"
          : "border-transparent text-muted hover:border-border hover:bg-primary-subtle hover:text-primary",
        className,
      )}
    >
      <Bookmark aria-hidden className={cn("h-4 w-4", optimistic && "fill-current")} />
    </button>
  );
}
