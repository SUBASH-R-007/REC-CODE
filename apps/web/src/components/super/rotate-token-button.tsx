"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound } from "lucide-react";
import { Button, Dialog } from "@recx/design";
import { rotateJudgeNodeToken } from "@/server/actions/super-judge";
import { ReasonDialog } from "@/components/super/reason-dialog";

/**
 * Rotate a judge node's token. The new token is shown ONCE in a dialog and
 * kept only in this component's memory; closing the dialog drops it. The
 * old token stops working at once.
 */
export function RotateTokenButton({ nodeId, hostname }: { nodeId: string; hostname: string }) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [token, setToken] = useState<string | null>(null);

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setAsking(true)}>
        <KeyRound className="h-3.5 w-3.5" aria-hidden />
        Rotate token
      </Button>
      {asking && (
        <ReasonDialog
          open
          onClose={() => setAsking(false)}
          title={`Rotate the token of ${nodeId}`}
          confirmLabel="Rotate token"
          danger
          description={
            <p>
              {hostname} stops being able to claim jobs until its worker is given the new token. Do this during a quiet
              moment, or drain the node first.
            </p>
          }
          onConfirm={async (reason) => {
            const result = await rotateJudgeNodeToken({ nodeId, reason });
            if (result.ok) setToken(result.data.token);
            return result;
          }}
        />
      )}
      {token !== null && (
        <Dialog
          open
          // The token is shown once and the old one is already revoked: only
          // "I have copied it" closes this (not Escape, not the backdrop).
          dismissible={false}
          title={`New token for ${nodeId}`}
          onClose={() => {
            setToken(null);
            router.refresh();
          }}
        >
          <div className="space-y-3 text-sm">
            <p>
              Copy it now: it is shown only this once and is not stored anywhere (only its sha256 is). Give it to the
              worker on {hostname} as RECX_NODE_TOKEN, then restart the worker.
            </p>
            <label className="block text-sm font-medium" htmlFor={`token-${nodeId}`}>
              Token
            </label>
            <input
              id={`token-${nodeId}`}
              readOnly
              value={token}
              onFocus={(e) => e.currentTarget.select()}
              className="w-full rounded-xl border border-border-strong bg-surface px-3 py-2 font-mono text-xs"
            />
            <div className="flex justify-end">
              <Button
                onClick={() => {
                  setToken(null);
                  router.refresh();
                }}
              >
                I have copied it
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}
