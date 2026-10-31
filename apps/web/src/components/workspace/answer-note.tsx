import { FileText } from "lucide-react";
import { ANSWER_NOTICES } from "@recx/shared";

/**
 * What an output-only question is, above the editor (Phase 12n).
 *
 * Three facts in the order somebody needs them while typing: this box
 * takes the ANSWER rather than a program, nothing is compiled or run, and
 * there is one case which they can see all of. Chips rather than prose
 * because this bar sits over the editor on a phone too; the sentences are
 * read out to a screen reader and printed in full in the Description tab,
 * where there is room for them.
 */
export function AnswerNote() {
  return (
    <p className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-border bg-primary-subtle px-3 py-1 text-xs text-text-secondary">
      <FileText className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
      <span className="font-medium text-text">your answer, not a program</span>
      <span aria-hidden>·</span>
      <span>nothing is compiled or run</span>
      <span aria-hidden>·</span>
      <span>one case, and you can see it</span>
      <span className="sr-only">
        . {ANSWER_NOTICES.whatToSubmit} {ANSWER_NOTICES.noProgram} {ANSWER_NOTICES.oneCase}
      </span>
    </p>
  );
}
