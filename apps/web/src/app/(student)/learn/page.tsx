import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/guards";
import { PlanIndex } from "@/components/plans/plan-index";

export const metadata: Metadata = { title: "Learning tracks" };

export default async function LearnPage() {
  const user = await requireUser();
  return <PlanIndex kind="TRACK" userId={user.id} />;
}
