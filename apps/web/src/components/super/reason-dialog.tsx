"use client";

import { useId, useState, useTransition } from "react";
import { Button, Dialog, Field, Textarea } from "@recx/design";
import type { ActionResult } from "@/lib/errors";

/**
 * A confirmation that needs a written reason (recorded in the audit log).
 * The server action validates the text again; this only helps. Used by the
 * /super client leaves.
 */
export function ReasonDialog({
  open,
  onClose,
  title,
  description,
  confirmLabel,
  danger,
  fieldLabel = "Reason",
  hint = "Recorded in the audit log with your name.",
  minLength = 10,
  maxLength = 500,
  optional = false,
  children,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  danger?: boolean;
  fieldLabel?: string;
  hint?: string;
  minLength?: number;
  maxLength?: number;
  /** The text may be left empty (e.g. an approval note). */
  optional?: boolean;
  /** Extra controls rendered above the reason (they read their own state). */
  children?: React.ReactNode;
  /** Resolves to the action result; the dialog closes on success. */
  onConfirm: (text: string) => Promise<ActionResult<unknown>>;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const trimmed = text.trim();

  const close = () => {
    if (pending) return;
    setText("");
    setError(null);
    onClose();
  };

  return (
    <Dialog open={open} onClose={close} title={title}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!(optional && trimmed.length === 0) && trimmed.length < minLength) {
            setError(`Write at least ${minLength} characters. It is recorded in the audit log.`);
            return;
          }
          setError(null);
          startTransition(async () => {
            const result = await onConfirm(trimmed);
            if (result.ok) {
              setText("");
              onClose();
            } else {
              setError(result.error);
            }
          });
        }}
      >
        <div className="space-y-2 text-sm text-text-secondary">{description}</div>
        {children}
        <Field label={fieldLabel} htmlFor={`${id}-text`} hint={hint} error={error}>
          <Textarea
            id={`${id}-text`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={maxLength}
            rows={3}
            required={!optional}
            aria-invalid={error ? true : undefined}
          />
        </Field>
        <div className="flex flex-wrap justify-end gap-2">
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
