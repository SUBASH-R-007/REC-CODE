import "server-only";

/**
 * Reading an HTML form body in a route handler, with a size cap.
 *
 * The unauthenticated auth routes (sign in, forgot password, reset password)
 * are plain `<form method="post">` targets, because the sign-in page ships
 * no JavaScript at all and the two password pages have no reason to differ.
 * A route handler has no body limit of its own — the 1 MB limit belongs to
 * server actions — so the cap is here, and the body is refused while it
 * streams rather than after it has been buffered.
 */

/**
 * The largest form body any of these routes can legitimately receive: a
 * ≤ 254-character identifier, a ≤ 1,024-character password twice and a
 * token, percent-encoded at up to 9 bytes per character. Comfortably under
 * this; anything larger is not our form.
 */
export const MAX_FORM_BYTES = 16 * 1024;

/**
 * The urlencoded body, or null when it is not our form at all: another
 * content type, a declared length over the cap, a body that exceeds the cap
 * while streaming, or a read that fails. A caller treats null as a refusal
 * and must not report which of those it was.
 */
export async function readFormBody(request: Request, maxBytes = MAX_FORM_BYTES): Promise<URLSearchParams | null> {
  const type = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") return null;
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) return null;
  if (!request.body) return new URLSearchParams();

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
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new URLSearchParams(new TextDecoder().decode(body));
}

/** 303 See Other: the browser follows with a GET. A relative Location stays on whatever host the visitor used. */
export function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store" } });
}
