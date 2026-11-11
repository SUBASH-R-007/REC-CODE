"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, X } from "lucide-react";
import { Button, Field, Select, Textarea, useToast } from "@recx/design";
import { INTERVIEW_LIMITS } from "@recx/shared";
import { decideInterviewExperience } from "@/server/actions/moderation";

/**
 * Approve or reject one interview submission (Phase 12e).
 *
 * The company select is the whole reason this is a form rather than two
 * buttons: approving with a company moves that company's "asked at"
 * counts, and approving without one publishes the account and moves
 * nothing. Both are legitimate, and the moderator should be choosing
 * rather than discovering.
 */
const CREATE = "__create__";

export function ExperienceDecision({
  experienceId,
  companies,
  suggestedCompanyId,
  problemCount,
  typedCompanyName,
}: {
  experienceId: string;
  companies: Array<{ id: string; name: string }>;
  suggestedCompanyId: string | null;
  problemCount: number;
  /** What the student typed, offered as a new catalogue entry. */
  typedCompanyName: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [companyId, setCompanyId] = useState(suggestedCompanyId ?? "");
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();

  const decide = (approve: boolean) =>
    startTransition(async () => {
      const result = await decideInterviewExperience({
        experienceId,
        approve,
        reason,
        companyId: companyId && companyId !== CREATE ? companyId : null,
        createCompany: companyId === CREATE,
      });
      if (!result.ok) {
        toast(result.error, "error");
        return;
      }
      toast(
        approve
          ? result.data.problemsTagged > 0
            ? `Published, and ${result.data.problemsTagged} company tag${result.data.problemsTagged === 1 ? "" : "s"} moved.`
            : "Published. No company tag moved."
          : "Not published. The student is shown your reason.",
        "success",
      );
      router.refresh();
    });

  return (
    <div className="mt-3 space-y-3 border-t border-border pt-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Which company in the catalogue?"
          htmlFor={`company-${experienceId}`}
          hint={
            problemCount === 0
              ? "No problems were named, so nothing is tagged either way."
              : `Choosing one adds ${problemCount} problem${problemCount === 1 ? "" : "s"} to its "asked at" counts.`
          }
        >
          <Select id={`company-${experienceId}`} value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
            <option value="">Do not link a company</option>
            <option value={CREATE}>Add &ldquo;{typedCompanyName}&rdquo; to the catalogue</option>
            {companies.map((company) => (
              <option key={company.id} value={company.id}>
                {company.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Your reason" htmlFor={`reason-${experienceId}`} hint="The student is shown this, either way.">
          <Textarea
            id={`reason-${experienceId}`}
            rows={2}
            minLength={INTERVIEW_LIMITS.decisionReason.min}
            maxLength={INTERVIEW_LIMITS.decisionReason.max}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" className="min-h-11" loading={pending} onClick={() => decide(true)}>
          <Check className="h-4 w-4" aria-hidden />
          Publish it
        </Button>
        <Button size="sm" variant="danger" className="min-h-11" disabled={pending} onClick={() => decide(false)}>
          <X className="h-4 w-4" aria-hidden />
          Do not publish
        </Button>
      </div>
    </div>
  );
}
