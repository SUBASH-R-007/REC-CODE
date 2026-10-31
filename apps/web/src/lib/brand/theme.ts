import "server-only";
import { revalidateTag, unstable_cache } from "next/cache";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { cache } from "react";
import { db } from "@/lib/db";
import { brandFromRow, FALLBACK_BRAND, PLATFORM_THEME_ID, type Brand } from "@/lib/brand/fallback";

export type { Brand } from "@/lib/brand/fallback";

/** Cache tag of the singleton PlatformTheme row. */
export const PLATFORM_THEME_TAG = "platform-theme";

/**
 * The stored theme row, cached across requests until revalidateBrand() —
 * deliberately no time-based revalidation: the brand changes only when a
 * super admin saves it, and that save revalidates the tag. A database
 * failure throws out of here, and unstable_cache never caches a throw, so a
 * transient outage cannot pin the fallback.
 */
const readThemeRow = unstable_cache(
  async () =>
    db.platformTheme.findUnique({
      where: { id: PLATFORM_THEME_ID },
      select: { palette: true, css: true },
    }),
  ["platform-theme", "v1"],
  { tags: [PLATFORM_THEME_TAG] },
);

let lastWarnAt = 0;

/**
 * The active brand for the root layout and generateViewport(). Deduplicated
 * per request; derivation never runs here — the row stores finished css.
 * Falls back to the canonical REC purple palette when the row is missing or
 * the database is unreachable (e.g. `next build` without a database).
 */
export const getBrand = cache(async (): Promise<Brand> => {
  // Every page is dynamic (the root layout reads headers()), so a build-time
  // render is only Next probing for static output; don't touch the database
  // (or wait out its connect timeout) for that.
  if (process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD) return FALLBACK_BRAND;
  try {
    return brandFromRow(await readThemeRow());
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
});

/** Call after saving the PlatformTheme row so every page picks it up. */
export function revalidateBrand(): void {
  revalidateTag(PLATFORM_THEME_TAG);
}
