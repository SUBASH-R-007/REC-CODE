"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, X } from "lucide-react";
import { Button, useToast } from "@recx/design";
import { commitRosterImport, discardRosterImport } from "@/server/actions/admin-roster";

/**
 * Commit or discard a previewed import. The hash of the diff on screen goes
 * with the commit: if anything changed since this page rendered, the commit
 * is refused and the page re-renders with the new diff.
 */
export function RosterCommitForm({
  importId,
  diffSha256,
  changes,
}: {
  importId: string;
  diffSha256: string;
  changes: number;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const run = (kind: "commit" | "discard") =>
    start(async () => {
      setError(null);
      const result =
        kind === "commit" ? await commitRosterImport({ importId, diffSha256 }) : await discardRosterImport({ importId });
      if (!result.ok) {
        setError(result.error);
        router.refresh();
        return;
      }
      toast(kind === "commit" ? "The roster import was committed." : "The preview was discarded.", "success");
      router.refresh();
    });

  return (
    <div className="space-y-3">
      {error ? (
        <p role="alert" className="rounded-xl border border-danger/30 bg-danger-subtle px-4 py-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => run("commit")} loading={pending} disabled={changes === 0}>
          {!pending && <Check className="h-4 w-4" aria-hidden />}
          {changes === 0 ? "Nothing to commit" : `Commit ${changes} ${changes === 1 ? "change" : "changes"}`}
        </Button>
        <Button variant="outline" onClick={() => run("discard")} disabled={pending}>
          <X className="h-4 w-4" aria-hidden />
          Discard preview
        </Button>
      </div>
    </div>
  );
}
