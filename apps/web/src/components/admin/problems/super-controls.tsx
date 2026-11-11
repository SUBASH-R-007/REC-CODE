"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, Trash2 } from "lucide-react";
import { Button, useToast } from "@recx/design";
import { ReasonDialog } from "@/components/admin/reason-dialog";
import { requestProblemDeletion, requestVersionDeletion, retireProblem } from "@/server/actions/super-problems";

/**
 * SUPER_ADMIN problem lifecycle: retire a published problem, or request the
 * deletion of a never-published revision or problem (two-person approval).
 * The page renders this only for SUPER_ADMIN; the actions enforce it with
 * requireSuperAdmin() regardless.
 */
export function SuperProblemControls({
  problemId,
  problemVersion,
  canRetire,
  deletableVersion,
  canRequestProblemDeletion,
}: {
  problemId: string;
  /** Problem.version the page was rendered with (optimistic concurrency). */
  problemVersion: number;
  canRetire: boolean;
  /** A never-published revision that could be deleted, if any. */
  deletableVersion: { id: string; revision: number } | null;
  canRequestProblemDeletion: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState<"retire" | "version" | "problem" | null>(null);

  return (
    <div className="flex flex-wrap gap-2">
      {canRetire && (
        <Button type="button" variant="danger" onClick={() => setOpen("retire")}>
          <Archive className="h-4 w-4" aria-hidden />
          Retire problem
        </Button>
      )}
      {deletableVersion && (
        <Button type="button" variant="outline" onClick={() => setOpen("version")}>
          <Trash2 className="h-4 w-4" aria-hidden />
          Request deletion of revision {deletableVersion.revision}
        </Button>
      )}
      {canRequestProblemDeletion && (
        <Button type="button" variant="outline" onClick={() => setOpen("problem")}>
          <Trash2 className="h-4 w-4" aria-hidden />
          Request deletion of the problem
        </Button>
      )}

      {open === "retire" && (
        <ReasonDialog
          open
          danger
          onClose={() => setOpen(null)}
          title="Retire this problem"
          confirmLabel="Confirm retirement"
          description={
            <p>
              The problem leaves the catalogue and gets no new revisions. Submissions keep showing the revision they were judged
              against. Retiring is recorded in the audit log and cannot be undone.
            </p>
          }
          onConfirm={async (reason) => {
            const result = await retireProblem({ problemId, expectedProblemVersion: problemVersion, reason });
            if (result.ok) {
              toast("Problem retired.", "success");
              router.refresh();
            }
            return result;
          }}
        />
      )}
      {open === "version" && deletableVersion && (
        <ReasonDialog
          open
          danger
          onClose={() => setOpen(null)}
          title={`Request deletion of revision ${deletableVersion.revision}`}
          confirmLabel="Request deletion"
          description={
            <p>
              Only a never-published revision with no submissions can be deleted. A second super-admin must approve the request
              (a break-glass self-approval is allowed, recorded and announced).
            </p>
          }
          onConfirm={async (reason) => {
            const result = await requestVersionDeletion({ problemVersionId: deletableVersion.id, reason });
            if (result.ok) toast("Deletion requested. A second super-admin must approve it.", "success");
            return result;
          }}
        />
      )}
      {open === "problem" && (
        <ReasonDialog
          open
          danger
          onClose={() => setOpen(null)}
          title="Request deletion of this problem"
          confirmLabel="Request deletion"
          description={
            <p>
              Only a never-published problem that nothing references can be deleted. A second super-admin must approve the
              request.
            </p>
          }
          onConfirm={async (reason) => {
            const result = await requestProblemDeletion({ problemId, reason });
            if (result.ok) toast("Deletion requested. A second super-admin must approve it.", "success");
            return result;
          }}
        />
      )}
    </div>
  );
}
