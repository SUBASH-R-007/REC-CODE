"use client";

import { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";
import { cn } from "../utils";

/**
 * Accessible modal built on the native <dialog> element —
 * focus trapping, Esc handling and backdrop come for free.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  size = "md",
  hideTitle,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  size?: "sm" | "md" | "lg";
  hideTitle?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // A visible title is wired up via aria-labelledby; without it titled modals
  // were announced with no accessible name at all.
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        // Click on the backdrop (the dialog element itself) closes.
        if (e.target === ref.current) onClose();
      }}
      aria-label={hideTitle ? title : undefined}
      aria-labelledby={hideTitle ? undefined : titleId}
      className={cn(
        "m-auto w-full rounded-2xl border border-border bg-surface p-0 text-text shadow-pop backdrop:bg-black/45 backdrop:backdrop-blur-[2px]",
        size === "sm" && "max-w-sm",
        size === "md" && "max-w-lg",
        size === "lg" && "max-w-2xl",
        open && "animate-pop-in",
      )}
    >
      <div className="p-5">
        <div className={cn("flex items-start justify-between gap-4", hideTitle ? "" : "mb-3")}>
          {!hideTitle && (
            <h2 id={titleId} className="font-display text-lg font-semibold">
              {title}
            </h2>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className={cn(
              "rounded-lg p-1.5 text-muted transition-colors hover:bg-primary-subtle hover:text-text",
              hideTitle && "absolute right-3 top-3 z-10",
            )}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
