import { cn } from "../utils";

/**
 * Standard empty state. The icon is decorative (aria-hidden) — the
 * heading/description carry the meaning for screen readers.
 */
export function EmptyState({
  title,
  description,
  action,
  icon,
  compact,
  className,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "gap-2 py-8" : "gap-3 py-14",
        className,
      )}
    >
      {icon ? (
        <div
          aria-hidden
          className={cn(
            "flex items-center justify-center rounded-2xl bg-primary-subtle text-primary",
            compact ? "h-10 w-10" : "h-14 w-14",
          )}
        >
          {icon}
        </div>
      ) : null}
      <h3 className="font-display text-base font-semibold">{title}</h3>
      {description ? (
        <p className="max-w-sm text-sm text-text-secondary">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
