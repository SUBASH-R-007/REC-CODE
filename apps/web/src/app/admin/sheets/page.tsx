import type { Metadata } from "next";
import { requireAdminScopePage } from "@/lib/auth/scope";
import { listPlansForAdmin } from "@/server/queries/admin-plans";
import { PlanIndexView } from "@/components/admin/plans/plan-views";

export const metadata: Metadata = { title: "Sheets" };

/** Every sheet (StudyPlan kind SHEET); enrolment figures count the viewer's students only. */
export default async function AdminSheetsPage() {
  const { scope } = await requireAdminScopePage();
  const plans = await listPlansForAdmin("SHEET", scope);
  return <PlanIndexView kind="SHEET" plans={plans} />;
}
