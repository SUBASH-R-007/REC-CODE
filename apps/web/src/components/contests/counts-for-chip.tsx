import Link from "next/link";
import { cn } from "@recx/design";
import type { LiveContestEntry } from "@/lib/contests/entry";

/**
 * "This submission counts for a contest" (Phase 12q, slice 3).
 *
 * A contest submission is derived from the rows, not from the link that
 * was followed, so the same workspace is reached from the arena, from the
 * catalogue and from a bookmark — and from all three the submission counts
 * towards the contest. That is the only rule a student can predict, but it
 * is also the one that can surprise them: someone who opened a problem to
 * practise, not knowing it is question B of a contest they registered for
 * that morning, would otherwise spend a wrong attempt before finding out.
 *
 * So the workspace says so, where the Submit button is, with the letter
 * the board uses and the clock they are working against. It is a link back
 * to the arena because the next thing such a student wants is the rest of
 * the questions.
 */
export function CountsForContestChip({ entry, className }: { entry: LiveContestEntry; className?: string }) {
  const ends = entry.endsAt.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });
  return (
    <Link
      href={`/contests/${entry.contestSlug}/arena?p=${encodeURIComponent(entry.index)}`}
      className={cn(
        "rounded-md border border-primary/30 bg-primary-subtle px-1.5 py-0.5 text-xs leading-tight whitespace-nowrap text-text",
        "transition-colors hover:bg-primary/15",
        className,
      )}
    >
      {entry.virtual ? "Virtual " : ""}Counts for {entry.index}
      <span className="sr-only">
        {". "}
        This submission counts towards the contest {entry.contestTitle}, as question {entry.index}
        {entry.virtual ? ", on your own virtual clock" : ""}. Your clock ends at {ends} IST. Open the arena.
      </span>
      <span aria-hidden> · {ends}</span>
    </Link>
  );
}
