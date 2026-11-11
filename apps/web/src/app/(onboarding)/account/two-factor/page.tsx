import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { SECOND_FACTOR_ROLES } from "@recx/shared";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { homeForRole, requireUserEnrollingSecondFactor } from "@/lib/auth/guards";
import { mustEnrolSecondFactor } from "@/lib/auth/second-factor";
import { secondFactorConfigured } from "@/lib/auth/totp";
import { db } from "@/lib/db";
import { SecondFactorSetup } from "@/components/staff/second-factor-setup";

export const metadata: Metadata = {
  title: "Two-step sign-in",
  description: "Set up an authenticator app on your admin account.",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * `/account/two-factor` — where an admin sets up a second factor
 * (Phase 16j).
 *
 * In `(onboarding)` and not under `(student)` or `/admin` for the same
 * reason `/account/new-password` is: `requireUser` BOUNCES a required-but-
 * unenrolled admin to this page, so a layout that called it would send them
 * here in a loop. The guard here reads the session itself.
 *
 * It is reachable in two situations and shows the same thing in both: an
 * admin the policy has just started requiring one of, who has no choice
 * about being here; and an admin who already has one and came to replace
 * their recovery codes or take it off. The page says which case it is by
 * what it renders, not by a different route.
 */
export default async function TwoFactorPage() {
  const user = await requireUserEnrollingSecondFactor();

  // Staff only (ROADMAP §3.1). A student reaching this URL goes home,
  // which is also what the actions behind it answer.
  if (!(SECOND_FACTOR_ROLES as readonly string[]).includes(user.role)) redirect(homeForRole(user.role));

  const forced = await mustEnrolSecondFactor(user);
  const configured = secondFactorConfigured();
  const [credential, recoveryCodesLeft] = await Promise.all([
    db.totpCredential.findUnique({ where: { userId: user.id }, select: { confirmedAt: true } }),
    db.totpRecoveryCode.count({ where: { userId: user.id, usedAt: null } }),
  ]);
  const enrolled = credential?.confirmedAt != null;

  return (
    <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-xl px-4 py-10 outline-none sm:py-16">
      <div className="rounded-2xl border border-border bg-surface p-6 shadow-card sm:p-8">
        <div className="flex items-center gap-2 text-primary">
          <ShieldCheck className="h-5 w-5" aria-hidden />
          <span className="text-sm font-semibold">{PRODUCT_NAME}</span>
        </div>
        <h1 className="mt-3 font-display text-2xl font-bold tracking-tight">Two-step sign-in</h1>

        {forced ? (
          <p className="mt-1 text-sm text-text-secondary">
            Your department requires a second step for admin accounts, {user.firstName}. Until this is set up, every
            admin page and every admin action sends you back here. Your own dashboard and profile still work — nothing
            you can do with them needs a second factor.
          </p>
        ) : (
          <p className="mt-1 text-sm text-text-secondary">
            Optional on this deployment, and worth doing: your account can release results, commit a roster import, run
            an export and act as another user.
          </p>
        )}

        <div className="mt-6">
          {configured ? (
            <SecondFactorSetup enrolled={enrolled} recoveryCodesLeft={recoveryCodesLeft} />
          ) : (
            /*
             * No encryption key, so a secret could be minted but not read
             * back — which would lock this account out at its next
             * sign-in. The page says so plainly rather than offering a
             * button that fails, and the super-admin switch refuses to turn
             * on in the same situation.
             */
            <p className="rounded-xl border border-warning/30 bg-warning-subtle px-3.5 py-2.5 text-sm text-text">
              This deployment has no encryption key for authenticator secrets, so one cannot be set up here yet. Whoever
              runs the deployment can add it — <code className="font-mono">TOTP_ENCRYPTION_KEY</code>, described in
              docs/RUNBOOK.md §2.22.
            </p>
          )}
        </div>
      </div>

      {!forced && (
        <p className="mt-6 text-center text-xs text-muted">
          {/* `next/link` on an App Router page; see the note on /second-factor. */}
          <Link href={homeForRole(user.role)} className="font-medium text-primary underline-offset-2 hover:underline">
            Back to the admin area
          </Link>
        </p>
      )}
    </main>
  );
}
