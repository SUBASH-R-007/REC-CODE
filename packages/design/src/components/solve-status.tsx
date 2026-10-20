import { CircleCheck, CircleDashed } from "lucide-react";
import { cn } from "../utils";

export type SolveState = "solved" | "attempted" | null;

/**
 * A student's state on a problem. Not attempted renders nothing at all —
 * absence, never a grey dot. Solved and attempted differ in icon shape
 * (filled vs hollow dashed) as well as colour, and always carry the word.
 */
export function SolveStatus({
  status,
  className,
}: {
  status?: SolveState;
  className?: string;
}) {
  if (status === null || status === undefined) return null;
  if (status === "solved") {
    return (
      <span
        data-solve-status="solved"
        className={cn("inline-flex items-center gap-1 text-sm font-medium text-success", className)}
      >
        <CircleCheck aria-hidden className="h-4 w-4 shrink-0 fill-current stroke-surface" />
        Solved
      </span>
    );
  }
  return (
    <span
      data-solve-status="attempted"
      className={cn("inline-flex items-center gap-1 text-sm font-medium text-accent", className)}
    >
      <CircleDashed aria-hidden className="h-4 w-4 shrink-0" />
      Attempted
    </span>
  );
}
