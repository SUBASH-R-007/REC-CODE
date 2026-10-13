"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { isExamPath } from "@/components/pwa/sw-routes";

async function unregisterAll(): Promise<void> {
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((r) => r.unregister()));
  } catch {
    // Nothing registered, or the browser refused: nothing to undo.
  }
}

/**
 * Registers /sw.js (production builds only) and renders nothing.
 *
 * - Development: any worker left by a production run on the same port is
 *   removed, because dev chunks are not content-hashed and a cache-first
 *   worker would serve stale code.
 * - Exam routes (/assessments/<id>/attempt, /contests/<id>/arena): the
 *   worker is unregistered, on the first load and on client-side
 *   navigation alike — a cached shell must never serve an exam. The worker
 *   also refuses to intercept those paths and unregisters itself when one
 *   is navigated to (public/sw.js).
 */
export function ServiceWorkerRegistration() {
  const pathname = usePathname();
  const registered = useRef(false);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production" || isExamPath(pathname ?? "/")) {
      registered.current = false;
      void unregisterAll();
      return;
    }
    if (registered.current) return;
    registered.current = true;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      // Non-fatal: the app works fully online without a worker.
      registered.current = false;
    });
  }, [pathname]);

  return null;
}
