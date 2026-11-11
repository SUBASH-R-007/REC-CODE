"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Lock, LockOpen } from "lucide-react";
import { Button, useToast } from "@recx/design";
import { setLegalHold } from "@/server/actions/super-settings";
import { ReasonDialog } from "@/components/super/reason-dialog";

/** Place or lift the legal hold that suspends every purge (SECURITY-audited). */
export function LegalHoldForm({ active }: { active: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const next = !active;
  return (
    <>
      <Button variant={next ? "danger" : "outline"} onClick={() => setOpen(true)}>
        {next ? <Lock className="h-4 w-4" aria-hidden /> : <LockOpen className="h-4 w-4" aria-hidden />}
        {next ? "Place legal hold" : "Lift legal hold"}
      </Button>
      {open && (
        <ReasonDialog
          open
          onClose={() => setOpen(false)}
          title={next ? "Place a legal hold" : "Lift the legal hold"}
          confirmLabel={next ? "Place legal hold" : "Lift legal hold"}
          danger={next}
          description={
            next ? (
              <p>Every retention purge and submission purge stops until the hold is lifted. Nothing is deleted meanwhile.</p>
            ) : (
              <p>The scheduled retention purges resume on the next scheduler tick.</p>
            )
          }
          onConfirm={async (reason) => {
            const result = await setLegalHold({ enabled: next, reason });
            if (result.ok) {
              toast(result.data.legalHold ? "Legal hold placed." : "Legal hold lifted.", "success");
              router.refresh();
            }
            return result;
          }}
        />
      )}
    </>
  );
}
