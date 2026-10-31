"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Power, PowerOff } from "lucide-react";
import { Button, useToast } from "@recx/design";
import { setLanguageEnabled } from "@/server/actions/admin-judge";
import { ReasonDialog } from "@/components/admin/reason-dialog";

/** Enable / disable one LanguageConfig row, with a reason (audited). */
export function LanguageToggle({
  languageConfigId,
  label,
  toolchainId,
  enabled,
  retired,
}: {
  languageConfigId: string;
  label: string;
  toolchainId: string;
  enabled: boolean;
  retired: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  if (!enabled && retired) return <span className="text-xs text-muted">Retired</span>;
  const next = !enabled;

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
        aria-label={`${next ? "Enable" : "Disable"} ${label}`}
      >
        {next ? <Power className="h-3.5 w-3.5" aria-hidden /> : <PowerOff className="h-3.5 w-3.5" aria-hidden />}
        {next ? "Enable" : "Disable"}
      </Button>
      {open && (
        <ReasonDialog
          open
          onClose={() => setOpen(false)}
          title={`${next ? "Enable" : "Disable"} ${label}`}
          confirmLabel={next ? "Enable language" : "Disable language"}
          danger={!next}
          description={
            next ? (
              <p>
                Students can submit in {label} (toolchain <span className="font-mono">{toolchainId}</span>) as soon as
                this is saved. Make sure every judge node serving the practice lanes has that toolchain installed.
              </p>
            ) : (
              <p>
                New submissions and runs in {label} are refused from now on. Jobs already queued are still judged, and
                existing submissions keep their verdicts.
              </p>
            )
          }
          onConfirm={async (reason) => {
            const result = await setLanguageEnabled({ languageConfigId, enabled: next, reason });
            if (result.ok) {
              toast(`${label} is now ${result.data.enabled ? "enabled" : "disabled"}.`, "success");
              router.refresh();
            }
            return result;
          }}
        />
      )}
    </>
  );
}
