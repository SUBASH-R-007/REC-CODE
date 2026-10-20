"use client";

import { useActionState } from "react";
import { FileUp } from "lucide-react";
import { Button, Field } from "@recx/design";
import { previewRosterImport } from "@/server/actions/admin-roster";

/**
 * The roster upload: a real multipart <form> bound to the preview action
 * (works before hydration). Success redirects to the preview; a refusal is
 * shown under the field.
 */
export function RosterImportForm({ maxKb }: { maxKb: number }) {
  const [state, formAction, pending] = useActionState(previewRosterImport, null);
  const error = state && !state.ok ? state.error : null;
  return (
    <form action={formAction} className="space-y-4" aria-busy={pending || undefined}>
      <Field
        label="Roster file (.csv)"
        htmlFor="roster-file"
        hint={`UTF-8 CSV with the header shown below, at most ${maxKb} KB and 5,000 rows.`}
        error={error}
      >
        <input
          id="roster-file"
          name="file"
          type="file"
          accept=".csv,text/csv"
          required
          aria-invalid={error ? true : undefined}
          className="block w-full rounded-xl border border-border-strong bg-surface px-3 py-2 text-sm text-text file:mr-3 file:rounded-lg file:border-0 file:bg-primary-subtle file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-primary"
        />
      </Field>
      <Button type="submit" loading={pending}>
        {!pending && <FileUp className="h-4 w-4" aria-hidden />}
        Preview the import
      </Button>
      <p className="text-xs text-text-secondary">
        Previewing changes nothing. You review every change before you commit, and the preview expires after an hour.
      </p>
    </form>
  );
}
