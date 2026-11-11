"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Ban, Check, Undo2, X } from "lucide-react";
import { Button, Dialog, Field, Textarea, useToast } from "@recx/design";
import type { AccommodationStatus } from "@recx/db";
import type { ActionResult } from "@/lib/errors";
import {
  approveAccommodation,
  rejectAccommodation,
  revokeAccommodation,
  withdrawAccommodation,
} from "@/server/actions/admin-accommodations";

type Mode = "approve" | "reject" | "revoke" | null;

const COPY: Record<Exclude<Mode, null>, { title: string; label: string; confirm: string; required: boolean; hint: string }> = {
  approve: {
    title: "Approve this accommodation?",
    label: "Note (optional)",
    confirm: "Approve",
    required: false,
    hint: "Stays with the accommodation; never written to the audit log.",
  },
  reject: {
    title: "Reject this request?",
    label: "Why it is rejected",
    confirm: "Reject",
    required: true,
    hint: "Stays with the accommodation; never written to the audit log.",
  },
  revoke: {
    title: "Revoke this accommodation?",
    label: "Reason for revoking",
    confirm: "Revoke",
    required: true,
    hint: "Recorded in the audit log. Do not include medical or disability details.",
  },
};

/**
 * Decisions on one accommodation. Approve, reject and revoke are for a
 * SUPER_ADMIN only — shown only to one, and refused by the server for anyone
 * else. Withdraw is for the requester (or a SUPER_ADMIN) while requested.
 */
export function DecisionPanel({
  id,
  status,
  isSuperAdmin,
  canWithdraw,
}: {
  id: string;
  status: AccommodationStatus;
  isSuperAdmin: boolean;
  canWithdraw: boolean;
}) {
  const fid = useId();
  const router = useRouter();
  const { toast } = useToast();
  const [mode, setMode] = useState<Mode>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const finish = (result: ActionResult<unknown>, done: string) => {
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setMode(null);
    setText("");
    toast(done, "success");
    router.refresh();
  };

  const showDecide = isSuperAdmin && status === "REQUESTED";
  const showRevoke = isSuperAdmin && status === "APPROVED";
  const showWithdraw = canWithdraw && status === "REQUESTED";
  if (!showDecide && !showRevoke && !showWithdraw) return null;
  const copy = mode ? COPY[mode] : null;

  return (
    <div className="flex flex-wrap gap-2">
      {showDecide ? (
        <>
          <Button onClick={() => setMode("approve")}>
            <Check className="h-4 w-4" aria-hidden />
            Approve
          </Button>
          <Button variant="outline" onClick={() => setMode("reject")}>
            <X className="h-4 w-4" aria-hidden />
            Reject
          </Button>
        </>
      ) : null}
      {showRevoke ? (
        <Button variant="danger" onClick={() => setMode("revoke")}>
          <Ban className="h-4 w-4" aria-hidden />
          Revoke
        </Button>
      ) : null}
      {showWithdraw ? (
        <Button
          variant="ghost"
          loading={pending && mode === null}
          onClick={() =>
            start(async () => {
              const result = await withdrawAccommodation({ id });
              if (!result.ok) toast(result.error, "error");
              else {
                toast("The request was withdrawn.", "success");
                router.refresh();
              }
            })
          }
        >
          <Undo2 className="h-4 w-4" aria-hidden />
          Withdraw request
        </Button>
      ) : null}

      <Dialog open={mode !== null} onClose={() => (pending ? undefined : setMode(null))} title={copy?.title ?? "Decision"}>
        {copy && mode ? (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              const note = text.trim();
              start(async () => {
                if (mode === "approve") finish(await approveAccommodation({ id, note: note || undefined }), "Approved.");
                else if (mode === "reject") finish(await rejectAccommodation({ id, note }), "Rejected.");
                else finish(await revokeAccommodation({ id, reason: note }), "Revoked.");
              });
            }}
          >
            <Field label={copy.label} htmlFor={`${fid}-text`} hint={copy.hint} error={error}>
              <Textarea
                id={`${fid}-text`}
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={3}
                required={copy.required}
                minLength={copy.required ? 5 : undefined}
                maxLength={mode === "revoke" ? 500 : 1000}
                aria-invalid={error ? true : undefined}
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setMode(null)} disabled={pending}>
                Cancel
              </Button>
              <Button type="submit" variant={mode === "approve" ? "primary" : "danger"} loading={pending}>
                {copy.confirm}
              </Button>
            </div>
          </form>
        ) : null}
      </Dialog>
    </div>
  );
}
