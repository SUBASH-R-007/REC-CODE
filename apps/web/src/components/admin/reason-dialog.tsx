"use client";

import { useId, useState, useTransition } from "react";
import { Button, Dialog, Field, Textarea } from "@recx/design";
import type { ActionResult } from "@/lib/errors";

const MIN_REASON = 5;
const MAX_REASON = 500;

/**
 * Confirmation that requires a free-text reason (recorded in the audit
 * log). The server action validates the reason again; this only helps.
 */
export function ReasonDialog({
  open,
  onClose,
  title,
  description,
  confirmLabel,
  danger,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** Resolves to the action result; the dialog closes on success. */
  onConfirm: (reason: string) => Promise<ActionResult<unknown>>;
}) {
  const id = useId();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const trimmed = reason.trim();

  const close = () => {
    if (pending) return;
    setReason("");
    setError(null);
    onClose();
  };

  return (
    <Dialog open={open} onClose={close} title={title}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed.length < MIN_REASON) {
            setError(`Give a reason of at least ${MIN_REASON} characters — it is recorded in the audit log.`);
            return;
          }
          setError(null);
          startTransition(async () => {
            const result = await onConfirm(trimmed);
            if (result.ok) {
              setReason("");
              onClose();
            } else {
              setError(result.error);
            }
          });
        }}
      >
        <div className="text-sm text-text-secondary">{description}</div>
        <Field label="Reason" htmlFor={`${id}-reason`} hint="Recorded in the audit log with your name." error={error}>
          <Textarea
            id={`${id}-reason`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={MAX_REASON}
            rows={3}
            required
            aria-invalid={error ? true : undefined}
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={close} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" variant={danger ? "danger" : "primary"} loading={pending}>
            {confirmLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
