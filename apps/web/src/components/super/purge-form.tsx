"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Eraser } from "lucide-react";
import { Button, Field, Input, useToast } from "@recx/design";
import { requestSubmissionPurge } from "@/server/actions/super-data";
import { ReasonDialog } from "@/components/super/reason-dialog";

/**
 * Request a purge of one student's PRACTICE source code before a date
 * (two-person approval). Verdict rows are kept; contest and assessment
 * sources are never purged; refused under legal hold.
 */
export function PurgeForm({ legalHold }: { legalHold: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const id = useId();
  const [collegeId, setCollegeId] = useState("");
  const [before, setBefore] = useState("");
  const [includeAccepted, setIncludeAccepted] = useState(false);
  const [open, setOpen] = useState(false);

  if (legalHold) return <p className="text-sm text-warning">A legal hold is in force: purges are refused until it is lifted.</p>;

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        setOpen(true);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Roll number" htmlFor={`${id}-roll`}>
          <Input id={`${id}-roll`} value={collegeId} onChange={(e) => setCollegeId(e.target.value)} required autoComplete="off" />
        </Field>
        <Field label="Submitted before (campus date)" htmlFor={`${id}-before`}>
          <Input id={`${id}-before`} type="date" value={before} onChange={(e) => setBefore(e.target.value)} required />
        </Field>
      </div>
      <label className="inline-flex items-center gap-2 text-sm">
        <input type="checkbox" checked={includeAccepted} onChange={(e) => setIncludeAccepted(e.target.checked)} />
        Include accepted solutions
      </label>
      <div>
        <Button type="submit" variant="outline">
          <Eraser className="h-4 w-4" aria-hidden />
          Request purge
        </Button>
      </div>
      {open && (
        <ReasonDialog
          open
          onClose={() => setOpen(false)}
          title={`Request a source purge for ${collegeId}`}
          confirmLabel="Send for approval"
          danger
          description={
            <p>
              Source code and visible-test output are removed; the verdicts stay (profile counters and past standings
              depend on them). A second super-admin must approve.
            </p>
          }
          onConfirm={async (reason) => {
            const result = await requestSubmissionPurge({ collegeId, before, includeAccepted, reason });
            if (result.ok) {
              toast(`Purge requested: ${result.data.count} source(s).`, "success");
              router.refresh();
            }
            return result;
          }}
        />
      )}
    </form>
  );
}
