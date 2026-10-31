import { PROBLEM_KIND_HINT, PROBLEM_KIND_LABEL, isNamedProblemKind, type ProblemKind } from "@recx/shared";
import { cn } from "@recx/design";

/**
 * What kind of question a row is, before a student opens it (Phase 12p).
 *
 * Nothing in the catalogue said this until now: Phases 12k to 12n each
 * explained their kind on the problem page and none of them touched the
 * list, so a query, a one-line fix, a conversation and an answer box all
 * looked like an ordinary program from the outside.
 *
 * An ordinary program gets no chip. A label on every row is a label
 * nobody reads, and what is worth saying is that THIS one is unlike the
 * rest. The word is text, not a colour — the chip is the same neutral
 * shape the topic tags use — and the sentence behind it is the short form
 * of what the problem page says at length once it is open.
 */
export function ProblemKindChip({ kind, className }: { kind: ProblemKind; className?: string }) {
  if (!isNamedProblemKind(kind)) return null;
  return (
    <span
      className={cn(
        "rounded-md border border-primary/30 bg-primary-subtle px-1.5 py-0.5 text-xs leading-tight whitespace-nowrap text-text",
        className,
      )}
    >
      {PROBLEM_KIND_LABEL[kind]}
      <span className="sr-only">. {PROBLEM_KIND_HINT[kind]}</span>
    </span>
  );
}
