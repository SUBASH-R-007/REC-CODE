import "server-only";

/**
 * Reading a request body in a route handler without letting the sender
 * choose how much memory we spend.
 *
 * **A route handler has no body limit of its own.** The 1 MB default belongs
 * to server actions; a `route.ts` under `app/` will happily buffer whatever
 * arrives.
 * `request.json()` and `request.text()` consume the whole stream before they
 * resolve, so checking the size *after* awaiting one of them bounds what is
 * PROCESSED and not what is ALLOCATED — by then the body is already in
 * memory. The check has to happen while the bytes arrive.
 *
 * That is what this does, and `readFormBody` has done it for the
 * unauthenticated auth forms since they were written. This module is that
 * same core, extracted so the JSON routes can share it rather than each
 * growing its own half-version: before Phase 17's audit, eight route
 * handlers read a body with no cap at all, and of the four that capped,
 * two compared `text.length` — UTF-16 code units, not bytes, so a body of
 * multi-byte characters measured short.
 *
 * Why it matters on this product specifically: the uncapped routes included
 * every live-exam route (`hb`, `mcq`, `run`) and the mock-interview
 * snapshot, which fires from a candidate's editor every few seconds. One
 * candidate posting one very large body could exhaust the web process that
 * is serving the sitting to everybody else in the hall. The sender is
 * authenticated and identified, which makes it a bad way to cheat — and no
 * reason at all to leave the door open.
 */

export type BoundedBody =
  | { readonly ok: true; readonly bytes: Uint8Array }
  /** Over the cap: refused mid-stream, so the rest was never allocated. */
  | { readonly ok: false; readonly reason: "too-large" }
  /** The stream failed, which a caller reports as a bad request, not a size. */
  | { readonly ok: false; readonly reason: "unreadable" };

/**
 * The body, or a refusal, never more than `maxBytes` of allocation.
 *
 * `content-length` is checked first because it is free, and then ignored:
 * it is the sender's claim, absent under chunked encoding and a lie
 * whenever it is convenient. The running total over the stream is the
 * check that actually holds.
 */
export async function readBoundedBody(request: Request, maxBytes: number): Promise<BoundedBody> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: "too-large" };
  if (!request.body) return { ok: true, bytes: new Uint8Array(0) };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too-large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

/**
 * The body as text, or null when it is larger than `maxBytes` or could not
 * be read — the shape four exam and draft routes each had their own copy of
 * before this module existed. They were identical and correct; one of them
 * is easier to audit, and `tests/repo/request-bodies.test.ts` can then
 * require that every route handler goes through this file.
 */
export async function readBoundedText(request: Request, maxBytes: number): Promise<string | null> {
  const body = await readBoundedBody(request, maxBytes);
  return body.ok ? new TextDecoder().decode(body.bytes) : null;
}

/**
 * The cap for a route whose body is a handful of fields — an id, an enum, a
 * token, a few counters. Generous by an order of magnitude for every one of
 * them, and small enough that a thousand concurrent senders cannot matter.
 * A route that legitimately carries a student's SOURCE passes its own cap,
 * derived from the limit that already bounds the source itself.
 */
export const MAX_JSON_BYTES = 16 * 1024;

export type JsonBody =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly status: 400 | 413; readonly message: string };

/**
 * A JSON body, bounded, or a refusal a caller can answer with directly.
 *
 * The content type is deliberately NOT checked. These routes accept what
 * their callers already send — `sendBeacon` uses `text/plain`, and a
 * same-origin `fetch` may send nothing at all — and this change is about
 * size. Narrowing the accepted content type is a separate decision with a
 * separate way to break a working client.
 */
export async function readJsonBody(request: Request, maxBytes: number = MAX_JSON_BYTES): Promise<JsonBody> {
  const body = await readBoundedBody(request, maxBytes);
  if (!body.ok) {
    return body.reason === "too-large"
      ? { ok: false, status: 413, message: "Request body too large." }
      : { ok: false, status: 400, message: "Request body could not be read." };
  }
  if (body.bytes.byteLength === 0) return { ok: false, status: 400, message: "Request body is empty." };
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(body.bytes)) as unknown };
  } catch {
    return { ok: false, status: 400, message: "Request body is not valid JSON." };
  }
}
