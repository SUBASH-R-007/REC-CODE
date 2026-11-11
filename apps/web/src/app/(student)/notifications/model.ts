import { z } from "zod";

/**
 * /notifications helpers (pure; test/shell-notifications.test.ts).
 */

export const NOTIFICATION_PAGE_SIZE = 25;

/** `?before=<notification id>` — anything else is ignored (first page). */
export const cursorSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

export function parseCursor(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = cursorSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const BASE = "https://recx.invalid";
// Controls and invisible format characters never belong in a link.
const UNSAFE = /[\p{Cc}\p{Cf}\\]/u;

/**
 * A notification's stored link, if — and only if — it is a same-origin path
 * ("/problems/two-sum", "/leaderboard?period=week"). Absolute URLs,
 * protocol-relative "//host", "javascript:" and anything with control
 * characters or backslashes yield null, so a notification can never send a
 * student off-site.
 */
export function safeNotificationHref(link: string | null | undefined): string | null {
  if (typeof link !== "string" || link.length === 0 || link.length > 512) return null;
  if (!link.startsWith("/") || link.startsWith("//") || UNSAFE.test(link)) return null;
  let url: URL;
  try {
    url = new URL(link, BASE);
  } catch {
    return null;
  }
  if (url.origin !== BASE) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}
