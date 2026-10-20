import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/guards";
import { getPublishedPlanMeta } from "@/components/plans/data";
import { isPlanSlug } from "@/components/plans/kinds";
import { PlanDetailView } from "@/components/plans/plan-detail";

type Params = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  // Unpublished plans do not leak their titles through metadata.
  const plan = isPlanSlug(slug) ? await getPublishedPlanMeta(slug) : null;
  return { title: plan ? plan.title : "Study plan not found" };
}

export default async function SheetsPlanPage({ params }: Params) {
  const user = await requireUser();
  const { slug } = await params;
  return <PlanDetailView kind="SHEET" slug={slug} userId={user.id} />;
}
