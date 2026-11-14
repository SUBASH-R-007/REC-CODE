import { requireActionUser } from "@/lib/auth/guards";
import { readBoundedText } from "@/lib/http/body";
import { MAX_BEACON_BODY_BYTES, isSameOriginRequest, parseBeaconBody } from "@/lib/drafts/schema";
import { saveServerDraft } from "@/lib/drafts/server";
import { AppError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request.headers)) return json({ error: "Cross-site request refused." }, 403);
  try {
    const user = await requireActionUser();
    const text = await readBoundedText(request, MAX_BEACON_BODY_BYTES);
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
