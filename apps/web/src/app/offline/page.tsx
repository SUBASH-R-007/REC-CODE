import type { Metadata } from "next";
import { WifiOff } from "lucide-react";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { Wordmark } from "@/components/shell/wordmark";

export const metadata: Metadata = { title: "Offline" };

/**
 * The service worker's fallback when a page navigation cannot reach the
 * network (public/sw.js precaches it, fetched without credentials). It must
 * stay free of personal data: no session read, no database query — it can
 * be shown to anyone on a shared lab machine.
 */
export default function OfflinePage() {
  return (
    <main id="main-content" tabIndex={-1} className="app-backdrop flex min-h-dvh items-center justify-center px-4 outline-none">
      <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-8 text-center shadow-card">
        <div className="flex justify-center">
          <Wordmark />
        </div>
        <span
          aria-hidden
          className="mx-auto mt-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary-subtle text-primary"
        >
          <WifiOff className="h-7 w-7" />
        </span>
        <h1 className="mt-4 font-display text-2xl font-bold tracking-tight">You&apos;re offline</h1>
        <p className="mt-2 text-sm text-text-secondary">
          {PRODUCT_NAME} needs a connection to load problems and judge your code. Your submissions are stored on the
          server, and drafts saved in this browser stay here — reconnect and pick up where you left off.
        </p>
        {/* A plain anchor, not <Link>: offline, this page's scripts may not be
            cached, so "Try again" must be a full navigation that works without
            hydration (the worker answers it network-first). */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a
          href="/"
          className="mt-6 inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-primary px-5 text-sm font-medium text-primary-fg shadow-sm transition-colors hover:bg-primary-hover"
        >
          Try again
        </a>
      </div>
    </main>
  );
}
