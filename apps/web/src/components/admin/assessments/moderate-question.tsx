"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Award, Ban, Undo2 } from "lucide-react";
import { Badge, Button, useToast } from "@recx/design";
import type { QuestionModeration } from "@recx/shared";
import { setQuestionModeration } from "@/server/actions/admin-assessments";
import { ReasonDialog } from "@/components/admin/reason-dialog";

/**
 * Award a question to everyone, or withdraw it from the paper (Phase 13i).
 *
 * On the results page's question-by-question table, which is the one
 * screen that says "a question everybody missed is usually a question,
 * not a cohort" — and until now said it with nothing a person could do
 * about it.
 *
 * Two buttons rather than a dropdown: these are two different decisions
 * with different consequences, and a select that silently holds
 * "Withdraw" is a decision waiting to be made by accident. A reason is
 * required for all three moves, undoing included.
 */

const COPY: Record<
  Exclude<QuestionModeration, "NONE"> | "NONE",
  { title: string; confirm: string; describe: (marks: string) => string }
> = {
  FULL_MARKS: {
    title: "Award this question to everyone",
    confirm: "Award it to everyone",
    describe: (marks) =>
      `Every candidate gets its ${marks} whatever they answered, including the ones who left it blank. The paper is still worth the same total. Use it when the question was answerable but unfairly marked.`,
  },
  DROPPED: {
    title: "Withdraw this question from the paper",
    confirm: "Withdraw it",
    describe: (marks) =>
      `The question counts for nobody, and its ${marks} come out of the total as well — a paper of 50 becomes a paper of 47, so the percentages stay honest. Use it when the question should never have been asked.`,
  },
  NONE: {
    title: "Mark this question normally again",
    confirm: "Undo the moderation",
    describe: () =>
      "Every candidate is marked on what they answered again, and the question is back in the total. Marks already released will move.",
  },
};

export function ModerateQuestion({
  assessmentId,
  kind,
  questionId,
  moderation,
  reason,
  marks,
}: {
  assessmentId: string;
  kind: "coding" | "mcq";
  questionId: string;
  moderation: QuestionModeration;
  reason: string | null;
  /** How much the question is worth, for the sentence in the dialog. */
  marks: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [asking, setAsking] = useState<QuestionModeration | null>(null);
  const copy = asking === null ? null : COPY[asking];

  const run = async (next: QuestionModeration, text: string) => {
    const result = await setQuestionModeration({
      assessmentId,
      kind,
      questionId,
      moderation: next,
      reason: text,
    });
    if (result.ok) {
      toast(
        next === "FULL_MARKS"
          ? "Awarded to everyone."
          : next === "DROPPED"
            ? "Withdrawn from the paper."
            : "Marked normally again.",
        "success",
      );
      router.refresh();
    }
    return result;
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {moderation === "NONE" ? (
        <>
          <Button size="sm" variant="ghost" onClick={() => setAsking("FULL_MARKS")} aria-label={`Award question ${questionId} to everyone`}>
            <Award className="h-3.5 w-3.5" aria-hidden />
            All
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAsking("DROPPED")} aria-label={`Withdraw question ${questionId}`}>
            <Ban className="h-3.5 w-3.5" aria-hidden />
            Drop
          </Button>
        </>
      ) : (
        <>
          <Badge tone={moderation === "DROPPED" ? "warning" : "info"}>
            {moderation === "DROPPED" ? "Withdrawn" : "Awarded to all"}
          </Badge>
          <Button size="sm" variant="ghost" onClick={() => setAsking("NONE")} aria-label={`Undo the moderation of question ${questionId}`}>
            <Undo2 className="h-3.5 w-3.5" aria-hidden />
            Undo
          </Button>
        </>
      )}
      {reason ? <span className="block w-full text-xs text-muted">{reason}</span> : null}
      {copy && asking !== null && (
        <ReasonDialog
          open
          onClose={() => setAsking(null)}
          title={copy.title}
          confirmLabel={copy.confirm}
          danger={asking === "DROPPED"}
          description={
            <>
              <p>{copy.describe(marks)}</p>
              <p className="mt-2">
                Candidates are told that the question was moderated, and never why — the reason you write is for
                staff, and a sentence explaining an answer would hand it to the next cohort.
              </p>
            </>
          }
          onConfirm={(text) => run(asking, text)}
        />
      )}
    </div>
  );
}
