"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Undo2 } from "lucide-react";
import { Button, useToast } from "@recx/design";
import { voidXpEvent } from "@/server/actions/super-xp";
import { ReasonDialog } from "@/components/super/reason-dialog";

/** Void one XP award: a compensating REVERSAL row (audited). */
export function VoidXpButton({ eventId, label }: { eventId: string; label: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)} aria-label={`Void ${label}`}>
        <Undo2 className="h-3.5 w-3.5" aria-hidden />
        Void
      </Button>
      {open && (
        <ReasonDialog
          open
          onClose={() => setOpen(false)}
          title={`Void ${label}`}
          confirmLabel="Void XP"
          danger
          description={
            <p>
              The ledger is append-only: this writes a reversal row and lowers the student&apos;s XP totals. Solved
              counters and frozen leaderboard snapshots do not change.
            </p>
          }
          onConfirm={async (reason) => {
            const result = await voidXpEvent({ eventId, reason });
            if (result.ok) {
              toast(`Voided ${result.data.amount} XP.`, "success");
              router.refresh();
            }
            return result;
          }}
        />
      )}
    </>
  );
}
