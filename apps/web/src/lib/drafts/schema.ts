import { z } from "zod";
import { MAX_CLOCK_SKEW_MS } from "@/lib/drafts/keys";
import { MAX_SOURCE_BYTES, fitsUtf8, languageSchema } from "@/lib/judge/submit-schema";

/**
 * The server boundary of draft saves: the `saveDraft` server action and the
 * POST /api/drafts beacon route validate with the same schema. Pure, so the
 * size and shape rules are unit-tested exactly as enforced.
 */

/** 256 KB of UTF-8 — the same cap as a submission. */
export const MAX_DRAFT_BYTES = MAX_SOURCE_BYTES;

/**
 * Largest beacon body read. JSON escaping can grow a 256 KB source (every
 * newline, quote and backslash doubles; control characters become \u00XX),
 * so the envelope is allowed more room than the source cap — the source
 * itself is still checked against MAX_DRAFT_BYTES after parsing.
 */
export const MAX_BEACON_BODY_BYTES = 2 * 1024 * 1024;

/** 2020-01-01 — anything earlier is a broken clock, not an edit time. */
const MIN_CLIENT_TIME_MS = Date.UTC(2020, 0, 1);
/** 2100-01-01 — keeps the value a valid Postgres timestamp. */
const MAX_CLIENT_TIME_MS = Date.UTC(2100, 0, 1);

export const draftProblemIdSchema = z
  .string({ invalid_type_error: "Choose a problem." })
  .min(1, "Choose a problem.")
  .max(64, "That problem is not valid.")
  .regex(/^[A-Za-z0-9_-]+$/, "That problem is not valid.");

/** An empty draft is legitimate (the student cleared the editor); NUL cannot be stored in Postgres text. */
export const draftSourceSchema = z
  .string({ invalid_type_error: "Your code must be text." })
  .refine((s) => fitsUtf8(s, MAX_DRAFT_BYTES), {
    message: "Your code is larger than 256 KB, so it is saved on this device only.",
  })
  .refine((s) => !s.includes("\u0000"), {
    message: "Your code contains a NUL character, so it is saved on this device only.",
  });

export const draftSaveSchema = z.object({
  problemId: draftProblemIdSchema,
  language: languageSchema,
  source: draftSourceSchema,
  /** Epoch ms of the edit that produced this source (the device's clock). */
  clientUpdatedAt: z
    .number({ invalid_type_error: "The edit time is not valid." })
    .int("The edit time is not valid.")
    .min(MIN_CLIENT_TIME_MS, "The edit time is not valid.")
    .max(MAX_CLIENT_TIME_MS, "The edit time is not valid."),
});

export type DraftSaveInput = z.input<typeof draftSaveSchema>;
export type DraftSave = z.output<typeof draftSaveSchema>;

/** Parse a beacon body (text/plain or application/json carrying the JSON envelope). */
export function parseBeaconBody(text: string): ReturnType<typeof draftSaveSchema.safeParse> {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    value = undefined;
  }
  return draftSaveSchema.safeParse(value);
}

/** Clamp a device's edit time to at most `now + MAX_CLOCK_SKEW_MS`. */
export function clampClientTime(clientMs: number, nowMs: number): number {
  return Math.min(clientMs, nowMs + MAX_CLOCK_SKEW_MS);
}

/** The headers this check reads (a Headers instance satisfies it). */
export interface HeaderReader {
  get(name: string): string | null;
}

/**
 * Cross-site request refusal for the cookie-authenticated beacon route
 * (defense in depth: the session cookie is SameSite=Lax, which already keeps
 * it off cross-site POSTs). Fetch metadata decides when the browser sends it;
 * otherwise the Origin must name this host. A request with neither header is
 * not a cross-site browser request and is allowed (like server actions).
 */
export function isSameOriginRequest(headers: HeaderReader): boolean {
  const site = headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  const origin = headers.get("origin");
  if (origin === null) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  return host !== null && host.split(",")[0]?.trim().toLowerCase() === originHost.toLowerCase();
}
