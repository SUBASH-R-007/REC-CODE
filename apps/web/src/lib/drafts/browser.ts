import { DRAFT_BEACON_URL, LANGUAGE_COOKIE, legacyDraftKey } from "@/lib/drafts/keys";
import type { DraftSaveInput } from "@/lib/drafts/schema";

/**
 * Browser-only helpers for the draft hook: the language cookie, the Phase 1
 * localStorage drafts (read once and migrated), and the page-hide beacon.
 * Every access is guarded — none of these may throw into the editor.
 */

/** Remember the student's language for a flash-free server render next time. */
export function rememberLanguage(language: string): void {
  try {
    const secure = window.location.protocol === "https:" ? "; secure" : "";
    document.cookie = `${LANGUAGE_COOKIE}=${encodeURIComponent(language)}; path=/; max-age=31536000; samesite=lax${secure}`;
  } catch {
    // Cookies blocked: the server falls back to the newest draft's language.
  }
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** A Phase 1 draft (localStorage, no timestamp), or null. */
export function readLegacyDraft(slug: string, language: string): string | null {
  try {
    return storage()?.getItem(legacyDraftKey(slug, language)) ?? null;
  } catch {
    return null;
  }
}

export function clearLegacyDraft(slug: string, language: string): void {
  try {
    storage()?.removeItem(legacyDraftKey(slug, language));
  } catch {
    // Ignore.
  }
}

/**
 * Send a draft while the page is being hidden or unloaded. sendBeacon
 * survives the unload; its body is text/plain (CORS-safelisted, no
 * preflight). Browsers cap in-flight beacon / keepalive bodies at 64 KB, so
 * a larger draft may not leave — its IndexedDB copy is already written and
 * the next visit syncs it. Returns whether the browser accepted the send.
 */
export function sendDraftBeacon(payload: DraftSaveInput): boolean {
  let body: string;
  try {
    body = JSON.stringify(payload);
  } catch {
    return false;
  }
  try {
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      if (navigator.sendBeacon(DRAFT_BEACON_URL, body)) return true;
    }
  } catch {
    // Fall through to fetch.
  }
  // No beacon, or the beacon quota refused it: a plain POST still completes
  // when the page is only being hidden (tab switch, phone lock). keepalive
  // shares the beacon's 64 KB budget, so it is asked for only below that.
  try {
    const keepalive = new Blob([body]).size < KEEPALIVE_MAX_BYTES;
    void fetch(DRAFT_BEACON_URL, {
      method: "POST",
      body,
      keepalive,
      credentials: "same-origin",
      headers: { "content-type": "text/plain;charset=UTF-8" },
    }).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

/** Browsers allow 64 KiB of in-flight keepalive bodies; leave headroom for other requests. */
const KEEPALIVE_MAX_BYTES = 60 * 1024;

/** True on Apple platforms (for showing the right editor shortcut). */
export function isApplePlatform(): boolean {
  try {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    const platform = nav.userAgentData?.platform ?? nav.platform ?? "";
    return /mac|iphone|ipad|ipod/i.test(platform);
  } catch {
    return false;
  }
}
