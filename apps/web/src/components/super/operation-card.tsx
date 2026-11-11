"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Ban, Check, Siren, X } from "lucide-react";
import { Button, useToast } from "@recx/design";
import {
  approvePrivilegedOperation,
  cancelPrivilegedOperation,
  rejectPrivilegedOperation,
  selfApprovePrivilegedOperation,
} from "@/server/actions/privileged";
import { ReasonDialog } from "@/components/super/reason-dialog";

type Mode = "approve" | "reject" | "cancel" | "breakGlass" | null;

/**
 * Decision buttons for one PENDING privileged operation. `mine` = the
 * viewer requested it (they may cancel or, in an emergency, break glass);
 * otherwise they may approve or reject. The server re-checks everything,
 * including that the payload digest is the one shown here.
 */
export function OperationActions({
  id,
  label,
  summary,
  payloadSha256,
  mine,
  breakGlassEnabled,
}: {
  id: string;
  label: string;
  summary: string;
  payloadSha256: string;
  mine: boolean;
  breakGlassEnabled: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [mode, setMode] = useState<Mode>(null);
  const close = () => setMode(null);
  const done = (message: string) => {
    toast(message, "success");
    router.refresh();
  };

  return (
    <div className="flex flex-wrap gap-2">
      {mine ? (
        <>
          <Button size="sm" variant="outline" onClick={() => setMode("cancel")}>
            <Ban className="h-3.5 w-3.5" aria-hidden />
            Cancel request
          </Button>
          {breakGlassEnabled ? (
            <Button size="sm" variant="danger" onClick={() => setMode("breakGlass")}>
              <Siren className="h-3.5 w-3.5" aria-hidden />
              Break glass
            </Button>
          ) : null}
        </>
      ) : (
        <>
          <Button size="sm" onClick={() => setMode("approve")}>
            <Check className="h-3.5 w-3.5" aria-hidden />
            Approve and run
          </Button>
          <Button size="sm" variant="outline" onClick={() => setMode("reject")}>
            <X className="h-3.5 w-3.5" aria-hidden />
            Reject
          </Button>
        </>
      )}

      {mode === "approve" && (
        <ReasonDialog
          open
          onClose={close}
          title={`Approve: ${label}`}
          confirmLabel="Approve and run now"
          fieldLabel="Note (optional)"
          optional
          minLength={0}
          description={
            <>
              <p>{summary}</p>
              <p>It runs as soon as you approve. You approve exactly the request shown here.</p>
            </>
          }
          onConfirm={async (note) => {
            const result = await approvePrivilegedOperation({ id, payloadSha256, note: note || undefined });
            if (result.ok) {
              done(result.data.status === "EXECUTED" ? "Approved and executed." : `Approved, but it failed: ${result.data.error ?? "see the audit log"}`);
            }
            return result;
          }}
        />
      )}
      {mode === "reject" && (
        <ReasonDialog
          open
          onClose={close}
          title={`Reject: ${label}`}
          confirmLabel="Reject request"
          fieldLabel="Why (the requester sees this)"
          minLength={5}
          danger
          description={<p>{summary}</p>}
          onConfirm={async (note) => {
            const result = await rejectPrivilegedOperation({ id, note });
            if (result.ok) done("Request rejected.");
            return result;
          }}
        />
      )}
      {mode === "cancel" && (
        <ReasonDialog
          open
          onClose={close}
          title={`Cancel: ${label}`}
          confirmLabel="Cancel request"
          fieldLabel="Note (optional)"
          optional
          minLength={0}
          description={<p>{summary}</p>}
          onConfirm={async () => {
            const result = await cancelPrivilegedOperation({ id });
            if (result.ok) done("Request cancelled.");
            return result;
          }}
        />
      )}
      {mode === "breakGlass" && (
        <ReasonDialog
          open
          onClose={close}
          title={`Break glass: ${label}`}
          confirmLabel="Self-approve and run"
          fieldLabel="Emergency justification"
          hint="At least 20 characters. Emailed to every super-admin and SECURITY-audited."
          minLength={20}
          maxLength={1000}
          danger
          description={
            <>
              <p>{summary}</p>
              <p>
                <strong>Break-glass skips the second approval.</strong> It is allowed, never quiet: every
                super-admin is emailed and notified, and the audit log records it as a security event.
              </p>
            </>
          }
          onConfirm={async (justification) => {
            const result = await selfApprovePrivilegedOperation({ id, payloadSha256, justification });
            if (result.ok) done(result.data.status === "EXECUTED" ? "Self-approved and executed." : "Self-approved, but it failed.");
            return result;
          }}
        />
      )}
    </div>
  );
}
