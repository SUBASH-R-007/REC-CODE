import { viewResponse } from "@/app/api/submissions/_lib/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The student view of one Run (owner or ADMIN / SUPER_ADMIN; 24 h TTL). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return viewResponse("run", id);
}
