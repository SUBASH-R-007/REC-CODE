import "server-only";
import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { env } from "@/lib/env";

/** sha256(ip + pepper). A raw IP is never stored anywhere. */
export function hashIp(ip: string): string {
  return createHash("sha256").update(ip + env().IP_HASH_PEPPER).digest("hex");
}

/**
 * Best-effort client IP for the current request. Forwarding headers are
 * client-controlled unless a trusted reverse proxy overwrites them, so they
 * are read only when TRUST_PROXY=true (Caddy sets X-Real-IP from the socket
 * address and appends X-Forwarded-For). Without a proxy there is no reliable
 * IP at this layer and null is returned.
 */
export async function requestIp(): Promise<string | null> {
  if (!env().TRUST_PROXY) return null;
  const h = await headers();
  const realIp = h.get("x-real-ip");
  if (realIp) return realIp.trim();
  const xff = h.get("x-forwarded-for");
  return xff ? xff.split(",")[0]!.trim() : null;
}

export async function requestIpHash(): Promise<string | null> {
  const ip = await requestIp();
  return ip ? hashIp(ip) : null;
}
