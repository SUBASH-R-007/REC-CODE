import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireAdminScopePage } from "@/lib/auth/scope";
import { getPlanForEdit, listPickableProblems } from "@/server/queries/admin-plans";
import { PlanEditView } from "@/components/admin/plans/plan-views";

export const metadata: Metadata = { title: "Edit track" };

type Params = Promise<{ id: string }>;

/** Edit one track. A plan of the other kind, or an unknown id, is a 404. */
export default async function AdminEditTrackPage({ params }: { params: Params }) {
  const { scope } = await requireAdminScopePage();
  const { id } = await params;
  const [plan, problems] = await Promise.all([getPlanForEdit(id, "TRACK", scope), listPickableProblems()]);
  if (!plan) notFound();
  return <PlanEditView plan={plan} problems={problems} />;
}
