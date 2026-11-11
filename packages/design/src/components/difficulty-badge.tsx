import type { DifficultyKey } from "@recx/shared";
import { cn } from "../utils";

const DIFFICULTY: Readonly<
  Record<DifficultyKey, { label: string; tone: string; bars: 1 | 2 | 3 }>
> = {
  EASY: { label: "Easy", tone: "bg-success-subtle text-success", bars: 1 },
  MEDIUM: { label: "Medium", tone: "bg-accent-subtle text-accent", bars: 2 },
  HARD: { label: "Hard", tone: "bg-danger-subtle text-danger", bars: 3 },
};

const BAR_HEIGHTS = ["h-1.5", "h-2", "h-2.5"] as const;

/**
 * Difficulty is never a bare coloured word: the word is always present and a
 * 1/2/3-of-3 bar meter repeats it without relying on hue.
 */
export function DifficultyBadge({
  difficulty,
  className,
}: {
  difficulty: DifficultyKey;
  className?: string;
}) {
  const d = DIFFICULTY[difficulty];
  return (
    <span
      data-difficulty={difficulty}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap",
        d.tone,
        className,
      )}
    >
      <span aria-hidden className="inline-flex items-end gap-0.5">
        {BAR_HEIGHTS.map((height, i) => (
          <span
            key={height}
            className={cn("w-[3px] rounded-full bg-current", height, i >= d.bars && "opacity-25")}
          />
        ))}
      </span>
      {d.label}
    </span>
  );
}
