"use client";

import { useSyncExternalStore } from "react";

/**
 * A media query's current match. The server (and the first client render,
 * during hydration) uses `serverDefault`, so markup never mismatches; the
 * real value takes over right after. Layout that must be right before
 * hydration is done in CSS; this drives behaviour (which editor to load,
 * which ARIA roles apply).
 */
export function useMediaQuery(query: string, serverDefault = false): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => (typeof window.matchMedia === "function" ? window.matchMedia(query).matches : serverDefault),
    () => serverDefault,
  );
}
