import { TOPIC_LABEL, type Topic } from "@recx/shared";
import { cn } from "@recx/design";

/** Small, non-interactive topic tags. Text only — the chip colour carries no meaning. */
export function TopicChips({ topics, className }: { topics: readonly Topic[]; className?: string }) {
  if (topics.length === 0) return null;
  return (
    <ul aria-label="Topics" className={cn("flex flex-wrap gap-1", className)}>
      {topics.map((topic) => (
        <li
          key={topic}
          className="rounded-md border border-border bg-background px-1.5 py-0.5 text-xs leading-tight whitespace-nowrap text-text-secondary"
        >
          {TOPIC_LABEL[topic]}
        </li>
      ))}
    </ul>
  );
}
