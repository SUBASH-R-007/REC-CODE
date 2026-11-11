import { MessagesSquare } from "lucide-react";
import { INTERACTIVE_NOTICES, LIMITS } from "@recx/shared";

/**
 * The rules of a conversation, above the editor (Phase 12l).
 *
 * Three facts in the order somebody needs them while typing: this question
 * is a dialogue, flush every line, and silence on both sides is a
 * deadlock. Chips rather than prose because this bar sits over the editor
 * on a phone too; the sentences are read out to a screen reader and
 * printed in full in the Description tab, where there is room.
 *
 * The missing flush is first among equals: it is the mistake every student
 * makes once, it looks exactly like a program that hangs, and the verdict
 * it earns says so in words.
 */
export function InteractiveNote() {
  const seconds = LIMITS.interactive.idleMs / 1000;
  return (
    <p className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-border bg-primary-subtle px-3 py-1 text-xs text-text-secondary">
      <MessagesSquare className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
      <span className="font-medium text-text">a conversation</span>
      <span aria-hidden>·</span>
      <span>flush every line</span>
      <span aria-hidden>·</span>
      <span>{seconds} s of silence is a deadlock</span>
      <span className="sr-only">
        . {INTERACTIVE_NOTICES.dialogue} {INTERACTIVE_NOTICES.flush} {INTERACTIVE_NOTICES.deadlock}
      </span>
    </p>
  );
}
