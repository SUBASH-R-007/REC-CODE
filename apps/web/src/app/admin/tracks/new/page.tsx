import type { Metadata } from "next";
import { requireAdminScopePage } from "@/lib/auth/scope";
import { PlanNewView } from "@/components/admin/plans/plan-views";

export const metadata: Metadata = { title: "New track" };

/** Create a track; it starts unpublished and admin-managed. */
export default async function AdminNewTrackPage() {
  await requireAdminScopePage();
  return <PlanNewView kind="TRACK" />;
}
