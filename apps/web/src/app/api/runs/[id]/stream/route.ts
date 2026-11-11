import { streamResponse } from "@/app/api/submissions/_lib/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Live result for one Run over Server-Sent Events. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return streamResponse(request, "run", id);
}
