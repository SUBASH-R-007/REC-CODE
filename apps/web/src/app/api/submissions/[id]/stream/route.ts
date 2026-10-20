import { streamResponse } from "@/app/api/submissions/_lib/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Live verdict for one submission over Server-Sent Events. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return streamResponse(request, "submission", id);
}
