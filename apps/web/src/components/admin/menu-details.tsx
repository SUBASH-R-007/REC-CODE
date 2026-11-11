"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

/**
 * The phone admin menu's <details>. The layout persists across client
 * navigation and React never touches `open`, so an opened menu would stay
 * open over the next page; this closes it whenever the path changes.
 * Without JavaScript it is a plain <details>.
 */
export function MenuDetails({ className, children }: { className?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const pathname = usePathname();
  useEffect(() => {
    if (ref.current) ref.current.open = false;
  }, [pathname]);
  return (
    <details ref={ref} className={className}>
      {children}
    </details>
  );
}
