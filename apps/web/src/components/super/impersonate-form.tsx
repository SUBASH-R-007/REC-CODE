"use client";

import { useId, useState, useTransition } from "react";
import { Eye } from "lucide-react";
import { Button, Field, Textarea } from "@recx/design";
import { startImpersonation } from "@/server/actions/super-impersonate";

const MIN = 20;
const MAX = 500;

/**
 * Start a read-only, 15-minute impersonation. On success the server
 * redirects to the target's home; a full-width banner then shows on every
 * page until it ends.
 */
export function ImpersonateForm({ targetUserId, collegeId }: { targetUserId: string; collegeId: string }) {
  const id = useId();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const trimmed = reason.trim();
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (trimmed.length < MIN) {
          setError(`Give a reason of at least ${MIN} characters. It is recorded in the audit log.`);
          return;
        }
        setError(null);
        startTransition(async () => {
          const result = await startImpersonation({ targetUserId, reason: trimmed });
          // Success never returns here: the server redirects.
          if (!result.ok) setError(result.error);
        });
      }}
    >
      <Field
        label={`Why do you need to view as ${collegeId}?`}
        htmlFor={`${id}-reason`}
        hint={`${MIN}–${MAX} characters. Recorded (SECURITY) at the start and the end.`}
        error={error}
      >
        <Textarea
          id={`${id}-reason`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          minLength={MIN}
          maxLength={MAX}
          rows={3}
          required
          aria-invalid={error ? true : undefined}
        />
      </Field>
      <Button type="submit" variant="danger" loading={pending}>
        <Eye className="h-4 w-4" aria-hidden />
        Start read-only view (15 minutes)
      </Button>
    </form>
  );
}
