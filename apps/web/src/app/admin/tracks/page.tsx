import type { Metadata } from "next";
import { requireAdminScopePage } from "@/lib/auth/scope";
import { listPlansForAdmin } from "@/server/queries/admin-plans";
import { PlanIndexView } from "@/components/admin/plans/plan-views";

export const metadata: Metadata = { title: "Learning tracks" };

/** Every track (StudyPlan kind TRACK); enrolment figures count the viewer's students only. */
export default async function AdminLearningtracksPage() {
  const { scope } = await requireAdminScopePage();
  const plans = await listPlansForAdmin("TRACK", scope);
  return <PlanIndexView kind="TRACK" plans={plans} />;
}
