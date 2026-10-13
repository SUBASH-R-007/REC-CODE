"use client";

import { useState, useTransition } from "react";
import { CheckCircle2, ShieldQuestion, XCircle } from "lucide-react";
import { Button } from "@recx/design";
import { verifyAuditChainDay } from "@/server/actions/super-audit";

/** Recompute one day's hash chain on the server and show the verdict (the check itself is audited). */
export function AuditVerifyButton({ day }: { day: string }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className="space-y-2">
      <Button
        variant="outline"
        size="sm"
        loading={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await verifyAuditChainDay({ day });
            if (!result.ok) setMessage({ ok: false, text: result.error });
            else if (result.data.intact)
              setMessage({
                ok: true,
                text: `${day}: ${result.data.rows} row(s), chain intact. Terminal hash ${result.data.terminalHash}.`,
              });
            else
              setMessage({
                ok: false,
                text: `${day}: chain BROKEN at row ${result.data.firstBadId ?? "?"} of ${result.data.rows}. Recorded as a security event.`,
              });
          })
        }
      >
        <ShieldQuestion className="h-3.5 w-3.5" aria-hidden />
        Verify {day}
      </Button>
      {message ? (
        <p
          role={message.ok ? "status" : "alert"}
          className={`flex items-start gap-2 break-all text-sm ${message.ok ? "text-success" : "text-danger"}`}
        >
          {message.ok ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          ) : (
            <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          )}
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
