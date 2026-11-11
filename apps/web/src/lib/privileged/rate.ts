import "server-only";
import { RateLimitError } from "@/lib/errors";
import { hitRateLimit, type RateLimitRule } from "@/lib/rate-limit";

/** Privileged-operation requests: at most 10 per super-admin per minute (the spec's admin bulk-operation limit). */
export const PRIVILEGED_REQUEST_RATE: RateLimitRule = { limit: 10, windowMs: 60_000 };

export async function enforcePrivilegedRequestRate(actorId: string): Promise<void> {
  const hit = await hitRateLimit(`privileged:${actorId}`, PRIVILEGED_REQUEST_RATE);
  if (!hit.allowed) throw new RateLimitError();
}
