"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ToggleLeft, ToggleRight } from "lucide-react";
import { Button, useToast } from "@recx/design";
import type { FeatureFlagKey } from "@recx/shared";
import { setFeatureFlag } from "@/server/actions/super-flags";
import { ReasonDialog } from "@/components/super/reason-dialog";

/** Turn one governance kill switch on or off (SECURITY-audited). */
export function FlagToggle({ flag, label, enabled }: { flag: FeatureFlagKey; label: string; enabled: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const next = !enabled;
  return (
    <>
      <Button size="sm" variant={next ? "outline" : "danger"} onClick={() => setOpen(true)} aria-label={`${next ? "Turn on" : "Turn off"} ${label}`}>
        {next ? <ToggleRight className="h-4 w-4" aria-hidden /> : <ToggleLeft className="h-4 w-4" aria-hidden />}
        {next ? "Turn on" : "Turn off"}
      </Button>
      {open && (
        <ReasonDialog
          open
          onClose={() => setOpen(false)}
          title={`${next ? "Turn on" : "Turn off"}: ${label}`}
          confirmLabel={next ? "Turn on" : "Turn off"}
          danger={!next}
          description={<p>Takes effect on the next request. Recorded as a security event.</p>}
          onConfirm={async (reason) => {
            const result = await setFeatureFlag({ key: flag, enabled: next, reason });
            if (result.ok) {
              toast(`${label} is ${result.data.enabled ? "on" : "off"}.`, "success");
              router.refresh();
            }
            return result;
          }}
        />
      )}
    </>
  );
}
