"use client";

import { PlanError } from "@/components/plans/plan-error";

export default function LearnError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <PlanError error={error} reset={reset} homeHref="/learn" homeLabel="All learning tracks" />;
}
