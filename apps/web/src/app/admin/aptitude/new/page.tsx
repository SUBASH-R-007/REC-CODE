import type { Metadata } from "next";
import { requirePageRole } from "@/lib/auth/guards";
import { AdminPageHeader } from "@/components/admin/admin-ui";
import { EMPTY_QUESTION, QuestionForm } from "@/components/admin/aptitude/question-form";

export const metadata: Metadata = { title: "New aptitude question" };

/**
 * `/admin/aptitude/new` — write one question (Phase 7d).
 *
 * It saves as a DRAFT and nothing else: publishing is a separate act, needs a
 * second pair of eyes, and is SUPER_ADMIN's. A form that could publish in one
 * press would make "a worked explanation nobody else has read" the normal
 * case.
 */
export default async function NewAptitudeQuestionPage() {
  await requirePageRole("ADMIN", "SUPER_ADMIN");
  return (
    <div className="space-y-6">
      <AdminPageHeader
        title="New aptitude question"
        description="Saved as a draft. A question needs a second pair of eyes before it can be published, and a worked explanation before it can be published at all."
        back={{ href: "/admin/aptitude", label: "Aptitude bank" }}
      />
      <QuestionForm initial={EMPTY_QUESTION} />
    </div>
  );
}
