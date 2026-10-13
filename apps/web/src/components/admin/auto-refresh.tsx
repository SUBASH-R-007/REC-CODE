"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pause, Play, RefreshCw } from "lucide-react";
import { Button, cn } from "@recx/design";

/**
 * Re-renders the server page every `intervalMs` with router.refresh() —
 * client state (an open dialog, a half-typed reason) survives. Skips ticks
 * while the tab is hidden, and can be paused (auto-updating content must be
 * stoppable).
 */
export function AutoRefresh({ updatedLabel, intervalMs = 10_000 }: { updatedLabel: string; intervalMs?: number }) {
  const router = useRouter();
  const [paused, setPaused] = useState(false);
  const [refreshing, startTransition] = useTransition();

  useEffect(() => {
    if (paused) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      startTransition(() => router.refresh());
    }, intervalMs);
    return () => clearInterval(timer);
  }, [paused, intervalMs, router]);

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
      <span className="inline-flex items-center gap-1.5 tabular-nums" aria-live="off">
        <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "motion-safe:animate-spin")} aria-hidden />
        {updatedLabel}
        {paused ? " · paused" : ` · refreshes every ${Math.round(intervalMs / 1000)} s`}
      </span>
      <Button variant="ghost" size="sm" onClick={() => setPaused((p) => !p)}>
        {paused ? <Play className="h-3.5 w-3.5" aria-hidden /> : <Pause className="h-3.5 w-3.5" aria-hidden />}
        {paused ? "Resume" : "Pause"}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={refreshing}
        onClick={() => startTransition(() => router.refresh())}
      >
        <RefreshCw className="h-3.5 w-3.5" aria-hidden />
        Refresh now
      </Button>
    </div>
  );
}
