"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Flag, XCircle } from "lucide-react";
import { Badge, Button, Dialog, Field, Select, Textarea, useToast } from "@recx/design";
import {
  PROBLEM_REPORT_LIMITS,
  PROBLEM_REPORT_OPEN_NOTE,
  PROBLEM_REPORT_REASONS,
  PROBLEM_REPORT_REASON_LABEL,
  type ProblemReportReason,
} from "@recx/shared";
import { reportProblem } from "@/server/actions/problem-reports";
import type { MyReport } from "@/lib/problems/reports";

/**
 * "Something here is wrong" (Phase 16a).
 *
 * Deliberately plain and deliberately small. A student who has just spent
 * twenty minutes on a problem whose expected output looks wrong is not in
 * the mood to hunt for this, and a prominent red button on every problem
 * page would invite a click from anybody who simply cannot solve it. So: a
 * quiet link under the samples, and a dialog that asks what is wrong in the
 * student's own words.
 *
 * It says what reporting does and does not do. Nothing about their
 * submissions changes, nothing is withheld, and a human reads it — because
 * the honest answer to "will this get my wrong answer overturned?" is "a
 * staff member will look", and a student who expects more than that will
 * not report the next one.
 */
export function ReportDefect({ problemId, mine }: { problemId: string; mine: readonly MyReport[] }) {
  const [open, setOpen] = useState(false);
  const hasOpenReport = mine.some((report) => report.status === "OPEN");
  const decided = mine.filter((report) => report.status !== "OPEN");

  return (
    <section aria-labelledby="problem-report-heading" className="space-y-2 border-t border-border pt-4">
      <h3 id="problem-report-heading" className="text-sm font-semibold">
        Something here looks wrong?
      </h3>
      {hasOpenReport ? (
        <p className="flex items-start gap-2 text-xs text-text-secondary">
          <Flag aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{PROBLEM_REPORT_OPEN_NOTE}</span>
        </p>
      ) : (
        <>
          <p className="text-xs text-text-secondary">
            Every problem here was written by staff at this college, so a wrong test case or a missing constraint is
            something only you are likely to notice. Reporting changes nothing about your submissions.
          </p>
          <Button type="button" variant="ghost" size="sm" className="min-h-11 px-0" onClick={() => setOpen(true)}>
            <Flag aria-hidden className="h-4 w-4" />
            Report a problem with this question
          </Button>
        </>
      )}

      {decided.length > 0 && (
        <ul className="space-y-2">
          {decided.map((report) => (
            <li key={report.id} className="rounded-xl border border-border bg-surface p-3 text-xs">
              <p className="flex flex-wrap items-center gap-2">
                <Badge tone={report.status === "UPHELD" ? "success" : "default"}>
                  {report.status === "UPHELD" ? (
                    <CheckCircle2 aria-hidden className="h-3.5 w-3.5" />
                  ) : (
                    <XCircle aria-hidden className="h-3.5 w-3.5" />
                  )}
                  {report.status === "UPHELD" ? "Upheld" : "Not changed"}
                </Badge>
                <span className="text-text-secondary">{PROBLEM_REPORT_REASON_LABEL[report.reason]}</span>
              </p>
              {report.resolution && <p className="mt-2 text-text-secondary">{report.resolution}</p>}
            </li>
          ))}
        </ul>
      )}

      {open && <ReportDialog problemId={problemId} onClose={() => setOpen(false)} />}
    </section>
  );
}

function ReportDialog({ problemId, onClose }: { problemId: string; onClose: () => void }) {
  const router = useRouter();
  const { toast } = useToast();
  const [reason, setReason] = useState<ProblemReportReason>("WRONG_EXPECTED_OUTPUT");
  const [detail, setDetail] = useState("");
  const [pending, startTransition] = useTransition();

  return (
    <Dialog open onClose={onClose} title="Report a problem with this question" size="sm">
      <form
        aria-label="Report a problem defect"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          startTransition(async () => {
            const result = await reportProblem({ problemId, reason, detail });
            if (!result.ok) {
              toast(result.error, "error");
              return;
            }
            toast("Reported. A staff member reads these.", "success");
            onClose();
            router.refresh();
          });
        }}
      >
        <Field label="What looks wrong?" htmlFor="defect-reason">
          <Select
            id="defect-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value as ProblemReportReason)}
          >
            {PROBLEM_REPORT_REASONS.map((value) => (
              <option key={value} value={value}>
                {PROBLEM_REPORT_REASON_LABEL[value]}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Tell them what you saw"
          htmlFor="defect-detail"
          hint="Which case, and what you expected instead. One or two sentences."
        >
          <Textarea
            id="defect-detail"
            rows={4}
            required
            maxLength={PROBLEM_REPORT_LIMITS.detail}
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
          />
        </Field>
        <p className="text-xs text-muted">
          This does not change your submissions and does not take the problem down. You will see the answer here.
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" className="min-h-11" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" className="min-h-11" loading={pending}>
            Report
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
