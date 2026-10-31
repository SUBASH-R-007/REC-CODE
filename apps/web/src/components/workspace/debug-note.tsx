import { Bug } from "lucide-react";
import { cn } from "@recx/design";
import { DEBUG_NOTICES, debugChipLabel, debugCountLabel, debugRuleSentence } from "@recx/shared";

/**
 * The rule of a debugging question, above the editor (Phase 12m).
 *
 * The budget and the count as it stands, side by side, because the count
 * is the only thing on this bar a student can change and the only one that
 * can refuse their submission. It turns red when it is over — the submit
 * action refuses the same source with the same two numbers, so the bar
 * cannot promise something the server will not honour.
 *
 * Chips rather than prose, like the SQL and conversation bars: this sits
 * over the editor on a phone too. The sentences are read out to a screen
 * reader and printed in full in the Description tab, where there is room.
 */
export function DebugNote({ budget, changed }: { budget: number; changed: number }) {
  const over = changed > budget;
  return (
    <p className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-border bg-primary-subtle px-3 py-1 text-xs text-text-secondary">
      <Bug className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
      <span className="font-medium text-text">{debugChipLabel(budget)}</span>
      <span aria-hidden>·</span>
      <span
        className={cn("font-medium", over ? "text-danger" : "text-text-secondary")}
        aria-live="polite"
        aria-atomic
      >
        {debugCountLabel(changed, budget)}
      </span>
      <span className="sr-only">
        . {debugRuleSentence(budget)} {DEBUG_NOTICES.counted} {DEBUG_NOTICES.why}
      </span>
    </p>
  );
}
