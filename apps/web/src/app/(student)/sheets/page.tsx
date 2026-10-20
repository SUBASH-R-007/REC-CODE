import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/guards";
import { PlanIndex } from "@/components/plans/plan-index";

export const metadata: Metadata = { title: "Sheets" };

export default async function SheetsPage() {
  const user = await requireUser();
  return <PlanIndex kind="SHEET" userId={user.id} />;
}
