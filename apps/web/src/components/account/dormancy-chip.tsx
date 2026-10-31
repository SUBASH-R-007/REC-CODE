import Link from "next/link";
import { CalendarHeart, CircleAlert, TriangleAlert } from "lucide-react";
import type { DormancyChip as Chip } from "@recx/shared";

/**
 * The dormancy countdown on `/dashboard` (Phase 8e).
 *
 * Accessibility requirements, not polish:
 *
 *   - never colour alone: an icon, the words, and an `aria-label` carrying
 *     the whole sentence including the way out;
 *   - NOT a `role="timer"` and not a per-tick live region. It is a static
 *     element that happens to contain a number. A countdown that announced
 *     itself repeatedly would make a screen reader unusable, the same rule
 *     Phase 6 applies to the exam timer;
 *   - the number is text, not a ring. A progress ring with the number only in
 *     the aria-label is a number sighted users have to count.
 *
 * It is shown only once something is actually counting: a chip reading "0 of
 * 10" on a student's first morning is a threat rather than information.
 */
export function DormancyChip({ chip }: { chip: Chip }) {
  if (!chip.show) return null;

  const Icon = chip.tone === "danger" ? TriangleAlert : chip.tone === "warning" ? CircleAlert : CalendarHeart;
  const border =
    chip.tone === "danger" ? "border-danger/40 bg-danger-subtle" : chip.tone === "warning" ? "border-warning/40 bg-warning-subtle" : "border-border bg-surface";

  return (
    <div className={`flex flex-wrap items-start gap-3 rounded-xl border p-4 ${border}`} aria-label={chip.label}>
      <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
      <div className="min-w-0 space-y-1 text-sm">
        {/* The sentence, in text. The aria-label repeats it so a reader gets
            it as one utterance rather than as fragments. */}
        <p>{chip.label}</p>
        <p>
          <Link href="/account/reactivate" className="text-primary underline">
            {chip.tone === "danger" ? "Put it back now" : "What this means"}
          </Link>
          {" · "}
          <Link href="/account/leave" className="text-primary underline">
            I was ill or away
          </Link>
        </p>
      </div>
    </div>
  );
}
