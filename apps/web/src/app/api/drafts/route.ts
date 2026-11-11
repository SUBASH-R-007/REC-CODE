import { requireActionUser } from "@/lib/auth/guards";
import { MAX_BEACON_BODY_BYTES, isSameOriginRequest, parseBeaconBody } from "@/lib/drafts/schema";
import { saveServerDraft } from "@/lib/drafts/server";
import { AppError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/drafts — the page-hide draft save, sent with
 * navigator.sendBeacon (text/plain body holding the JSON envelope) when the
 * workspace is hidden or unloaded. Auth is the session cookie; the body is
 * validated with the same schema as the saveDraft action (≤ 256 KB source)
 * and upserted newest-wins. Beacon responses are never read by the browser;
 * the status codes are for the keepalive-fetch fallback, tests and logs.
 */

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/** Read at most `limit` bytes of the body; null when it is larger. */
async function readBounded(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request.headers)) return json({ error: "Cross-site request refused." }, 403);
  try {
    const user = await requireActionUser();
    const text = await readBounded(request, MAX_BEACON_BODY_BYTES);
    if (text === null) return json({ error: "The draft is too large." }, 413);
    const parsed = parseBeaconBody(text);
    if (!parsed.success) {
      return json({ error: parsed.error.issues[0]?.message ?? "The draft is not valid." }, 422);
    }
    return json(await saveServerDraft(user.id, parsed.data), 200);
  } catch (error) {
    if (error instanceof AppError) return json({ error: error.message }, error.status);
    console.error("[drafts] beacon save failed:", error);
    return json({ error: "The draft could not be saved." }, 500);
  }
}
