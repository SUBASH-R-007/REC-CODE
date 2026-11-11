import type { Metadata } from "next";
import { ButtonLink, Card } from "@recx/design";
import { requirePageRole } from "@/lib/auth/guards";
import { CreateAssessmentForm } from "@/components/admin/assessments/assessment-forms";

export const metadata: Metadata = { title: "New assessment" };

/**
 * Create an assessment (Phase 12a). It arrives as a DRAFT with nothing to
 * sit: questions and halls are added on its own page, and publishing is what
 * freezes the terms.
 */
export default async function NewAssessmentPage() {
  await requirePageRole("ADMIN", "SUPER_ADMIN");

  return (
    <div className="max-w-3xl">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold text-text">New assessment</h1>
          <p className="mt-1 text-sm text-text-secondary">
            It starts as a draft. The window, the clock, the proctor mode and the placement flag stop being editable
            the moment it is published — a candidate&rsquo;s result has to mean what it meant when they sat it.
          </p>
        </div>
        <ButtonLink href="/admin/assessments" variant="outline">
          Back
        </ButtonLink>
      </div>
      <Card className="p-5">
        <CreateAssessmentForm />
      </Card>
    </div>
  );
}
