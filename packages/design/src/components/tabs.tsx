"use client";

import { createContext, useContext, useId, useState } from "react";
import { cn } from "../utils";

const TabsContext = createContext<{
  active: string;
  setActive: (v: string) => void;
  baseId: string;
} | null>(null);

function useTabs() {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error("Tab and TabPanel must be used inside <Tabs>");
  return ctx;
}

export function Tabs({
  defaultValue,
  children,
  className,
}: {
  defaultValue: string;
  children: React.ReactNode;
  className?: string;
}) {
  const [active, setActive] = useState(defaultValue);
  const baseId = useId();
  return (
    <TabsContext.Provider value={{ active, setActive, baseId }}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  );
}

export function TabList({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="scroll-thin flex gap-1 overflow-x-auto rounded-xl border border-border bg-surface p-1"
    >
      {children}
    </div>
  );
}

export function Tab({ value, children }: { value: string; children: React.ReactNode }) {
  const ctx = useTabs();
  const selected = ctx.active === value;
  return (
    <button
      type="button"
      role="tab"
      id={`${ctx.baseId}-tab-${value}`}
      aria-selected={selected}
      aria-controls={`${ctx.baseId}-panel-${value}`}
      onClick={() => ctx.setActive(value)}
      className={cn(
        "rounded-lg px-3.5 py-1.5 text-sm font-medium whitespace-nowrap transition-colors",
        selected
          ? "bg-primary text-primary-fg shadow-sm"
          : "text-text-secondary hover:bg-primary-subtle hover:text-text",
      )}
    >
      {children}
    </button>
  );
}

export function TabPanel({
  value,
  children,
  className,
}: {
  value: string;
  children: React.ReactNode;
  className?: string;
}) {
  const ctx = useTabs();
  if (ctx.active !== value) return null;
  return (
    <div
      role="tabpanel"
      id={`${ctx.baseId}-panel-${value}`}
      aria-labelledby={`${ctx.baseId}-tab-${value}`}
      className={cn("mt-4", className)}
    >
      {children}
    </div>
  );
}
