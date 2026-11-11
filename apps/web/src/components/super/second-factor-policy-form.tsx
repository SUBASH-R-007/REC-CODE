"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck, ShieldOff } from "lucide-react";
import { Button, useToast } from "@recx/design";
import { setSecondFactorPolicy } from "@/server/actions/super-settings";

/**
 * Require a second factor of admin accounts, or stop requiring it
 * (Phase 16j, SECURITY-audited).
 *
 * The asymmetry in the copy is the asymmetry in the behaviour, and it is
 * worth a sentence on screen: switching this OFF stops NEW admins being
 * made to enrol, and does not weaken an account that already has an
 * authenticator app — a confirmed credential is always asked for at
 * sign-in. Taking one off is the holder's own action, with a current code.
 */
export function SecondFactorPolicyForm({ required, configured }: { required: boolean; configured: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const next = !required;

  return (
    <div className="space-y-3">
      <p className="text-sm text-text-secondary">
        {required
          ? "Every ADMIN and SUPER_ADMIN must have an authenticator app. Until one is set up, every admin page and every staff action refuses and points at /account/two-factor; the pages any signed-in account has — their dashboard and profile — still open."
          : "Admins may set up an authenticator app and are not made to. Anybody who has one is still asked for a code at every sign-in."}
      </p>
      {!configured && (
        <p className="rounded-xl border border-warning/30 bg-warning-subtle px-3.5 py-2.5 text-sm text-text">
          This deployment has no <code className="font-mono">TOTP_ENCRYPTION_KEY</code>, so an admin could not set an
          app up at all. Requiring it would send every admin to a page that cannot mint a secret, including whoever
          turned it on — so it is refused until the key is there. See docs/RUNBOOK.md §2.22.
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-xl border border-danger/25 bg-danger-subtle px-3.5 py-2.5 text-sm text-danger">
          {error}
        </p>
      )}
      <Button
        variant={next ? "primary" : "outline"}
        loading={busy}
        disabled={next && !configured}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await setSecondFactorPolicy({ required: next });
            if (result.ok) {
              toast(result.data.required ? "A second factor is now required of admins." : "No longer required.", "success");
              router.refresh();
            } else {
              setError(result.error);
            }
          })
        }
      >
        {next ? <ShieldCheck className="h-4 w-4" aria-hidden /> : <ShieldOff className="h-4 w-4" aria-hidden />}
        {next ? "Require a second factor of admins" : "Stop requiring it"}
      </Button>
    </div>
  );
}
