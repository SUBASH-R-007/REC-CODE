"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Dialog, Field, Input, Select, Textarea, useToast } from "@recx/design";
import { PROBLEM_REPORT_LIMITS } from "@recx/shared";
import { clearQualityHold, decideProblemReport } from "@/server/actions/problem-reports";

/**
 * Answering a defect report, and releasing a problem (Phase 16a).
 *
 * The decision form asks for the sentence before it asks about the hold,
 * because the sentence is the part the student reads and the hold is the
 * part that is easy to tick without thinking. Upholding without a hold is
 * the ordinary case: "you are right, the fix is in revision 4" needs no
 * problem withheld from anything.
 */
export function DecideReport({ reportId, reason }: { reportId: string; reason: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="ghost" size="sm" className="min-h-11" onClick={() => setOpen(true)}>
        Answer
      </Button>
      {open && <DecideDialog reportId={reportId} reason={reason} onClose={() => setOpen(false)} />}
    </>
  );
}

function DecideDialog({
  reportId,
  reason,
  onClose,
}: {
  reportId: string;
  reason: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [status, setStatus] = useState<"UPHELD" | "DISMISSED">("UPHELD");
  const [resolution, setResolution] = useState("");
  const [hold, setHold] = useState(false);
  const [holdReason, setHoldReason] = useState("");
  const [pending, startTransition] = useTransition();

  return (
    <Dialog open onClose={onClose} title="Answer this report" size="md">
      <form
        aria-label="Answer a defect report"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          startTransition(async () => {
            const result = await decideProblemReport({
              reportId,
              status,
              resolution,
              hold,
              holdReason: hold ? holdReason : null,
            });
            if (!result.ok) {
              toast(result.error, "error");
              return;
            }
            toast(hold ? "Answered, and the problem is withheld from new papers." : "Answered.", "success");
            onClose();
            router.refresh();
          });
        }}
      >
        <p className="text-sm text-text-secondary">
          Reported as: <span className="font-medium text-text">{reason}</span>
        </p>
        <Field label="What did you decide?" htmlFor="decide-status">
          <Select
            id="decide-status"
            value={status}
            onChange={(e) => {
              const next = e.target.value as "UPHELD" | "DISMISSED";
              setStatus(next);
              // A hold only exists on an upheld report; the server says so
              // too, and a tick left behind by a changed mind would be a
              // refused submit for a reason nobody can see.
              if (next !== "UPHELD") setHold(false);
            }}
          >
            <option value="UPHELD">The report is right</option>
            <option value="DISMISSED">The problem is correct as written</option>
          </Select>
        </Field>
        <Field
          label="What the student is shown"
          htmlFor="decide-resolution"
          hint="They read this sentence. Say what you checked and what happens next."
        >
          <Textarea
            id="decide-resolution"
            rows={4}
            required
            maxLength={PROBLEM_REPORT_LIMITS.resolution}
            value={resolution}
            onChange={(e) => setResolution(e.target.value)}
          />
        </Field>
        {status === "UPHELD" && (
          <>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 rounded border-border-strong text-primary"
                checked={hold}
                onChange={(e) => setHold(e.target.checked)}
              />
              <span>
                Withhold this problem from new papers until it is fixed.
                <span className="block text-xs text-muted">
                  Existing papers and sittings are untouched, and students can still solve it in practice.
                </span>
              </span>
            </label>
            {hold && (
              <Field
                label="Why it is withheld"
                htmlFor="decide-hold-reason"
                hint="The next examiner reads this instead of guessing."
              >
                <Input
                  id="decide-hold-reason"
                  required
                  maxLength={PROBLEM_REPORT_LIMITS.holdReason}
                  value={holdReason}
                  onChange={(e) => setHoldReason(e.target.value)}
                />
              </Field>
            )}
          </>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" className="min-h-11" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" className="min-h-11" loading={pending}>
            Save the answer
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Releasing a problem. Separate from answering the report on purpose: the
 * fix lands in a new revision, which is a different day's work by possibly a
 * different person, and a hold that lifted itself when the report closed
 * would be a hold that never held anything.
 */
export function ClearHold({ problemId }: { problemId: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();

  return (
    <>
      <Button type="button" variant="secondary" size="sm" className="min-h-11" onClick={() => setOpen(true)}>
        Release it for new papers
      </Button>
      {open && (
        <Dialog open onClose={() => setOpen(false)} title="Release this problem" size="sm">
          <form
            aria-label="Release a withheld problem"
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              startTransition(async () => {
                const result = await clearQualityHold({ problemId, reason });
                if (!result.ok) {
                  toast(result.error, "error");
                  return;
                }
                toast("Released. It can be pinned into a paper again.", "success");
                setOpen(false);
                router.refresh();
              });
            }}
          >
            <p className="text-sm text-text-secondary">
              Only release it once the defect is actually fixed — in a new revision, published. The release is audited.
            </p>
            <Field label="What changed?" htmlFor="release-reason" hint="Recorded in the audit log.">
              <Input id="release-reason" required maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="ghost" className="min-h-11" onClick={() => setOpen(false)} disabled={pending}>
                Cancel
              </Button>
              <Button type="submit" className="min-h-11" loading={pending}>
                Release
              </Button>
            </div>
          </form>
        </Dialog>
      )}
    </>
  );
}
