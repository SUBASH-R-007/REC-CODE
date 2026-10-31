"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, X } from "lucide-react";
import { Button, Field, Input, useToast } from "@recx/design";
import { commitRosterImport, discardRosterImport } from "@/server/actions/admin-roster";

/**
 * Commit or discard a previewed import. The hash of the diff on screen goes
 * with the commit: if anything changed since this page rendered, the commit
 * is refused and the page re-renders with the new diff.
 *
 * The initial password (Phase 11f) is deliberately asked for HERE and not on
 * the upload form: it applies only to the accounts this commit creates, and
 * by now the diff on screen says how many that is. It is not part of the
 * hashed plan, because it changes no outcome — only what a created row's
 * password is.
 */
export function RosterCommitForm({
  importId,
  diffSha256,
  changes,
  creates,
  minLength,
}: {
  importId: string;
  diffSha256: string;
  changes: number;
  creates: number;
  minLength: number;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [error, setError] = useState<string | null>(null);
  const [initialPassword, setInitialPassword] = useState("");
  const [pending, start] = useTransition();

  const run = (kind: "commit" | "discard") =>
    start(async () => {
      setError(null);
      const result =
        kind === "commit"
          ? await commitRosterImport({ importId, diffSha256, initialPassword: initialPassword || undefined })
          : await discardRosterImport({ importId });
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

      {creates > 0 ? (
        <div className="max-w-md rounded-xl border border-border bg-elevated p-4">
          <Field
            label={`Initial password for the ${creates} new ${creates === 1 ? "account" : "accounts"} (optional)`}
            htmlFor="initialPassword"
            hint={`At least ${minLength} characters, with a letter and a number. Each student is made to replace it the first time they sign in. Leave it blank and they choose their own through “Forgot your password, or never set one?”.`}
          >
            <Input
              id="initialPassword"
              name="initialPassword"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={initialPassword}
              onChange={(event) => setInitialPassword(event.target.value)}
              maxLength={1024}
              placeholder="Leave blank to send them a link instead"
            />
          </Field>
          {initialPassword ? (
            <p className="mt-2 text-xs text-text-secondary">
              Tell the students this password yourself. It is stored only as a hash, so nobody — including you — can
              read it back from here afterwards.
            </p>
          ) : null}
        </div>
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
