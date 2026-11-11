"use client";

import { useRouter } from "next/navigation";
import { GitBranchPlus } from "lucide-react";
import { Button } from "@recx/design";
import { startRevision } from "@/server/actions/admin-problems";
import { useActionRunner } from "./use-action";

/**
 * "Create new revision": clone the live (frozen) revision into a new DRAFT.
 * A problem has at most one open draft; if one exists the server returns it.
 */
export function CreateRevisionButton({ problemId }: { problemId: string }) {
  const router = useRouter();
  const { run, pending, error } = useActionRunner();
  return (
    <div className="space-y-2">
      <Button
        type="button"
        loading={pending}
        onClick={() =>
          run(() => startRevision({ problemId }), {
            refresh: false,
            success: (d) => (d.existing ? `Revision ${d.revision} is already open.` : `Draft revision ${d.revision} created.`),
            onSuccess: () => {
              router.push(`/admin/problems/${problemId}`);
              router.refresh();
            },
          })
        }
      >
        {!pending && <GitBranchPlus className="h-4 w-4" aria-hidden />}
        Create new revision
      </Button>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
