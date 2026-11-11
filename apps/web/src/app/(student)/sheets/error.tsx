"use client";

import { PlanError } from "@/components/plans/plan-error";

export default function SheetsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <PlanError error={error} reset={reset} homeHref="/sheets" homeLabel="All sheets" />;
}
