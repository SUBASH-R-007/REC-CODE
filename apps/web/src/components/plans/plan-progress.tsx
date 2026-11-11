import { CircleCheck } from "lucide-react";
import { ProgressBar, cn } from "@recx/design";
import { solvedText } from "@/components/plans/kinds";

/** "4 of 12 solved" as text, with the bar repeating it visually (the text is primary). */
export function PlanProgress({
  done,
  total,
  title,
  size = "md",
  className,
}: {
  done: number;
  total: number;
  /** Plan title, for the progress bar's accessible name. */
  title: string;
  size?: "sm" | "md";
  className?: string;
}) {
  const complete = total > 0 && done >= total;
  return (
    <div className={cn("space-y-1.5", className)}>
      <p className="flex items-center gap-1.5 text-sm font-medium text-text">
        {complete ? <CircleCheck aria-hidden className="h-4 w-4 text-success" /> : null}
        {solvedText(done, total)}
        {complete ? <span className="text-text-secondary">· complete</span> : null}
      </p>
      <ProgressBar
        value={done}
        max={Math.max(total, 1)}
        size={size}
        tone={complete ? "success" : "primary"}
        label={`${title}: ${solvedText(done, total)}`}
      />
    </div>
  );
}
