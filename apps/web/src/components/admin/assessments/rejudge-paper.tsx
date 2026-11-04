"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Button, useToast } from "@recx/design";
import { rejudgeAssessment } from "@/server/actions/admin-judge";
import { ReasonDialog } from "@/components/admin/reason-dialog";

/**
 * Rejudge every program handed in for this paper (Phase 13h.3).
 *
 * The button is here, on the results page, because this is where somebody
 * reads the question-by-question table and realises a question everybody
 * failed was the question's fault. A reason is required and recorded: a
 * rejudge changes marks, and after the results are released it changes
 * marks a candidate has already read — which is why the warning below is
 * written out rather than implied.
 */
export function RejudgePaper({
  assessmentId,
  programs,
  released,
}: {
  assessmentId: string;
  /** Judged programs on finished sittings — what the action would move. */
  programs: number;
  released: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);

  if (programs === 0) {
    return (
      <p className="text-sm text-text-secondary">
        Nothing to rejudge: no finished sitting of this paper has a judged program.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm">
        Every program handed in on a finished sitting goes back into the queue and is judged again against the
        question as it stands now — <strong className="tabular-nums">{programs}</strong>{" "}
        {programs === 1 ? "program" : "programs"} of your students&apos;. Use it after fixing a question&apos;s tests;
        marks move as the verdicts come back.
      </p>
      <p className="text-sm text-text-secondary">
        Multiple-choice answers are not touched — they have no judge. Sittings still in progress are left alone, and
        so is any program whose code has been purged, which keeps the verdict it already has.
      </p>
      {released ? (
        <p className="rounded-lg border border-warning/40 bg-warning-subtle p-3 text-sm">
          <strong>These results are released.</strong> Candidates can already read their marks, and a rejudge can
          change them. Withdrawing the results first means nobody reads a mark that is about to move.
        </p>
      ) : null}
      <Button variant="outline" onClick={() => setOpen(true)}>
        <RefreshCw className="h-4 w-4" aria-hidden />
        Rejudge every program
      </Button>
      {open && (
        <ReasonDialog
          open
          onClose={() => setOpen(false)}
          title="Rejudge this paper"
          confirmLabel="Rejudge every program"
          description={
            <>
              <p>
                {programs} {programs === 1 ? "program" : "programs"} will be queued again on the rejudge lane, which
                is weighted so it cannot starve a live exam. Their current verdicts are replaced by whatever the
                judge returns.
              </p>
              {released ? (
                <p className="mt-2 text-danger">
                  The marks for this paper are already released to the candidates.
                </p>
              ) : null}
            </>
          }
          onConfirm={async (reason) => {
            const result = await rejudgeAssessment({ assessmentId, reason });
            if (result.ok) {
              toast(
                `${result.data.count} ${result.data.count === 1 ? "program" : "programs"} queued for rejudging.`,
                "success",
              );
              router.refresh();
            }
            return result;
          }}
        />
      )}
    </div>
  );
}
