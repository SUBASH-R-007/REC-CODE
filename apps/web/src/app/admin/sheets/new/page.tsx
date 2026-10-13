import type { Metadata } from "next";
import { requireAdminScopePage } from "@/lib/auth/scope";
import { PlanNewView } from "@/components/admin/plans/plan-views";

export const metadata: Metadata = { title: "New sheet" };

/** Create a sheet; it starts unpublished and admin-managed. */
export default async function AdminNewSheetPage() {
  await requireAdminScopePage();
  return <PlanNewView kind="SHEET" />;
}
