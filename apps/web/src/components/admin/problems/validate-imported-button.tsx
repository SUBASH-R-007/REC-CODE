"use client";

import { FlaskConical } from "lucide-react";
import { Button } from "@recx/design";
import { validateImportedDrafts } from "@/server/actions/admin-problems";
import { useActionRunner } from "./use-action";

/**
 * Start validation for every draft an import created or revised. The runs
 * go to the REJUDGE lane (at most 20 % of judge slots), so a large import
 * validates over a while; each draft's validation page shows its progress.
 */
export function ValidateImportedButton({ importId, disabled }: { importId: string; disabled: boolean }) {
  const { run, pending, error } = useActionRunner();
  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        loading={pending}
        onClick={() =>
          run(() => validateImportedDrafts({ importId }), {
            success: (d) => `Validation started for ${d.started} draft(s)${d.skipped ? `; ${d.skipped} have no runnable model solution` : ""}.`,
          })
        }
      >
        {!pending && <FlaskConical className="h-4 w-4" aria-hidden />}
        Validate imported drafts
      </Button>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
