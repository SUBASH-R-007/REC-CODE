"use client";

import { useRef } from "react";
import { cn } from "@recx/design";

export interface TabStripItem<T extends string> {
  value: T;
  label: React.ReactNode;
  /** Id of the panel this tab controls (rendered by the caller). */
  panelId: string;
  tabId: string;
}

/**
 * An ARIA tablist (APG "tabs with automatic activation"): one tab stop,
 * Arrow keys / Home / End move between tabs and select them. The caller
 * renders the panels (kept mounted, toggled with `hidden`) so their state —
 * revealed hints, scroll position, the editor — survives tab switches.
 */
export function TabStrip<T extends string>({
  label,
  items,
  value,
  onChange,
  className,
  tabClassName,
}: {
  label: string;
  items: readonly TabStripItem<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
  tabClassName?: string;
}) {
  const refs = useRef(new Map<T, HTMLButtonElement>());

  function move(from: number, delta: number | "first" | "last") {
    const count = items.length;
    if (count === 0) return;
    const index = delta === "first" ? 0 : delta === "last" ? count - 1 : (from + delta + count) % count;
    const next = items[index];
    if (!next) return;
    onChange(next.value);
    refs.current.get(next.value)?.focus();
  }

  return (
    <div role="tablist" aria-label={label} className={cn("flex items-center gap-1", className)}>
      {items.map((item, index) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            ref={(el) => {
              if (el) refs.current.set(item.value, el);
              else refs.current.delete(item.value);
            }}
            type="button"
            role="tab"
            id={item.tabId}
            aria-selected={selected}
            aria-controls={item.panelId}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight") move(index, 1);
              else if (e.key === "ArrowLeft") move(index, -1);
              else if (e.key === "Home") move(index, "first");
              else if (e.key === "End") move(index, "last");
              else return;
              e.preventDefault();
            }}
            className={cn(
              "inline-flex h-(--ws-ctl) shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm font-medium whitespace-nowrap transition-colors",
              selected
                ? "bg-primary-subtle font-semibold text-primary shadow-[inset_0_-2px_0_var(--primary)]"
                : "text-text-secondary hover:bg-primary-subtle/60 hover:text-text",
              tabClassName,
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
