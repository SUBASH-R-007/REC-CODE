import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { brandFromRow, FALLBACK_BRAND, PLATFORM_THEME_ID, type Brand } from "@/lib/brand/brand-core";
import { liveSession } from "@/lib/auth/session-token";
import { processDb } from "@/lib/db-client";

/**
 * Server-side data for the Pages Router — that is, the sign-in page
 * (src/pages/login.tsx) and its _document. Next refuses `server-only` and
 * App Router APIs (next/headers, next/cache's revalidateTag) anywhere in a
 * pages/ import graph, so this module reaches the database through
 * src/lib/db-client.ts rather than src/lib/db.ts — the SAME process-wide
 * client (one pool per process, production included). It is imported only
 * from getServerSideProps and _document.getInitialProps, which Next strips
 * from client bundles (and Prisma would not bundle for a browser anyway).
 */

/** Does this raw session cookie belong to a live session whose account may sign in? */
export async function hasLiveSession(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  return (await liveSession(processDb(), token)) !== null;
}

let lastWarnAt = 0;

/**
 * The active brand, read per request (the sign-in page is not hot: one
 * primary-key read per sign-in view). Same rules as getBrand() in
 * src/lib/brand/theme.ts: the build never touches the database, and a
 * missing row or an unreachable database yields the REC purple fallback.
 */
export async function brandForPages(): Promise<Brand> {
  if (process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD) return FALLBACK_BRAND;
  try {
    return brandFromRow(
      await processDb().platformTheme.findUnique({
        where: { id: PLATFORM_THEME_ID },
        select: { palette: true, css: true },
      }),
    );
  } catch (error) {
    const now = Date.now();
    if (now - lastWarnAt > 60_000) {
      lastWarnAt = now;
      console.warn(
        "[brand] PlatformTheme unavailable; using the REC purple fallback:",
        error instanceof Error ? error.message : error,
      );
    }
    return FALLBACK_BRAND;
  }
}
