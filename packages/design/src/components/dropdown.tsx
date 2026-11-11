"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "../utils";

export function Dropdown({
  trigger,
  align = "end",
  children,
  triggerLabel,
}: {
  trigger: React.ReactNode;
  align?: "start" | "end";
  children: React.ReactNode;
  triggerLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={triggerLabel}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center rounded-lg transition-colors"
      >
        {trigger}
      </button>
      {open && (
        <div
          role="menu"
          onClick={() => setOpen(false)}
          className={cn(
            "animate-pop-in absolute z-40 mt-2 min-w-48 overflow-hidden rounded-xl border border-border bg-elevated p-1.5 shadow-pop",
            align === "end" ? "right-0" : "left-0",
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export function DropdownItem({
  children,
  onClick,
  destructive,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors",
        destructive
          ? "text-danger hover:bg-danger-subtle"
          : "text-text hover:bg-primary-subtle",
      )}
    >
      {children}
    </button>
  );
}
