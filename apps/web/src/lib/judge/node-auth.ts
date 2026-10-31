import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import type { ZodType, ZodTypeDef } from "zod";
import type { JudgeNode } from "@recx/db";
import { JUDGE_HEADERS, JUDGE_PROTOCOL_VERSION } from "@recx/shared";
import { db } from "@/lib/db";
import { referenceId } from "@/lib/errors";

/**
 * Authentication and request plumbing for the judge-node protocol
 * (/api/judge/*). A node presents three headers on every request:
 *
 *   x-recx-judge-protocol: <JUDGE_PROTOCOL_VERSION>   mismatch → 426
 *   x-recx-judge-node:     <JudgeNode.id>
 *   authorization:         Bearer <node token>         sha256 → JudgeNode.tokenHash
 *
 * The token is narrowly scoped: it can heartbeat, claim a job, fetch the
 * blobs of the job it holds, and post or release that job — nothing else.
 * The header checks are pure functions so they are unit-tested without a
 * database.
 */

/** Protocol bodies are small; a result with sample stdout is well under this. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BEARER_PATTERN = /^Bearer ([A-Za-z0-9._~+/=-]{16,512})$/;
/** Compared against when the node id is unknown, so timing does not reveal which ids exist. */
const DUMMY_TOKEN_HASH = createHash("sha256").update("recx-judge-unknown-node").digest("hex");

export function judgeJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

// ── Pure header checks ───────────────────────────────────────────────────

export interface ProtocolMismatch {
  error: string;
  expected: number;
  received: string | null;
}

export type ProtocolCheck = { ok: true } | { ok: false; status: 426; body: ProtocolMismatch };

/** The worker's protocol version must equal ours exactly (header or body field). */
export function checkProtocolVersion(received: string | number | null | undefined): ProtocolCheck {
  const value = received === null || received === undefined ? null : String(received).trim();
  if (value === String(JUDGE_PROTOCOL_VERSION)) return { ok: true };
  return {
    ok: false,
    status: 426,
    body: {
      error: "Judge protocol version mismatch. Upgrade the judge worker to match this server.",
      expected: JUDGE_PROTOCOL_VERSION,
      received: value,
    },
  };
}

/** The token from "authorization: Bearer <token>", or null when absent / malformed. */
export function parseBearer(header: string | null): string | null {
  if (!header) return null;
  return BEARER_PATTERN.exec(header.trim())?.[1] ?? null;
}

export function parseNodeId(header: string | null): string | null {
  const value = header?.trim() ?? "";
  return NODE_ID_PATTERN.test(value) ? value : null;
}

export type NodeCredentials =
  | { ok: true; nodeId: string; token: string }
  | { ok: false; status: 401 | 426; body: { error: string } | ProtocolMismatch };

const AUTH_FAILED = { error: "Judge node authentication failed." } as const;

/** Protocol first (426), then node id + bearer token presence (401). */
export function readNodeCredentials(headers: Headers): NodeCredentials {
  const protocol = checkProtocolVersion(headers.get(JUDGE_HEADERS.protocol));
  if (!protocol.ok) return protocol;
  const nodeId = parseNodeId(headers.get(JUDGE_HEADERS.node));
  const token = parseBearer(headers.get("authorization"));
  if (!nodeId || !token) return { ok: false, status: 401, body: AUTH_FAILED };
  return { ok: true, nodeId, token };
}

export function hashNodeToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time comparison of sha256(token) with the stored hex hash. */
export function nodeTokenMatches(token: string, tokenHash: string): boolean {
  const actual = Buffer.from(hashNodeToken(token), "hex");
  const stored = /^[0-9a-f]{64}$/.test(tokenHash) ? tokenHash : DUMMY_TOKEN_HASH;
  const equal = timingSafeEqual(actual, Buffer.from(stored, "hex"));
  return equal && stored === tokenHash;
}

// Node status after a heartbeat and lane eligibility live in ./lanes.ts.

// ── Request plumbing ─────────────────────────────────────────────────────

export type NodeAuth = { ok: true; node: JudgeNode } | { ok: false; response: Response };

export async function authenticateNode(request: Request): Promise<NodeAuth> {
  const credentials = readNodeCredentials(request.headers);
  if (!credentials.ok) return { ok: false, response: judgeJson(credentials.body, credentials.status) };

  const node = await db.judgeNode.findUnique({ where: { id: credentials.nodeId } });
  const matches = nodeTokenMatches(credentials.token, node?.tokenHash ?? DUMMY_TOKEN_HASH);
  if (!node || !matches) {
    console.warn(`[judge] rejected credentials for node ${credentials.nodeId}`);
    return { ok: false, response: judgeJson(AUTH_FAILED, 401) };
  }
  return { ok: true, node };
}

export type BodyRead<T> = { ok: true; body: T } | { ok: false; response: Response };

/**
 * Parse and validate a protocol body. The body's protocolVersion must match
 * as well as the header (426), so a proxy cannot splice an old body under a
 * new header.
 */
export async function readJudgeBody<T extends { protocolVersion: number }>(
  request: Request,
  schema: ZodType<T, ZodTypeDef, unknown>,
): Promise<BodyRead<T>> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) {
    return { ok: false, response: judgeJson({ error: "Request body too large." }, 413) };
  }
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) {
    return { ok: false, response: judgeJson({ error: "Request body too large." }, 413) };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, response: judgeJson({ error: "Request body is not valid JSON." }, 400) };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "body"}: ${i.message}`);
    return { ok: false, response: judgeJson({ error: "Request body failed validation.", issues }, 400) };
  }
  const protocol = checkProtocolVersion(parsed.data.protocolVersion);
  if (!protocol.ok) return { ok: false, response: judgeJson(protocol.body, protocol.status) };
  return { ok: true, body: parsed.data };
}

/** Wrap a handler: unexpected errors are logged with a reference id and masked. */
export async function judgeRoute(name: string, handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    const ref = referenceId();
    console.error(`[judge] ${name} failed (ref ${ref}):`, error);
    return judgeJson({ error: "Internal error.", ref }, 500);
  }
}
