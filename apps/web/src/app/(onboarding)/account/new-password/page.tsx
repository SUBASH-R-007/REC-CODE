import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { KeyRound } from "lucide-react";
import { PASSWORD_MIN_LENGTH } from "@/lib/auth/password";
import { homeForRole, requireUserSettingInitialPassword } from "@/lib/auth/guards";
import { FirstPasswordForm } from "@/components/account/first-password-form";
import { PRODUCT_NAME } from "@/lib/brand/names";

export const metadata: Metadata = {
  title: "Set your password",
  description: `Replace the password your department gave you before you use ${PRODUCT_NAME}.`,
  robots: { index: false, follow: false },
};

/**
 * `/account/new-password` — the one authenticated page an account still
 * holding its admin-set initial password can reach (Phase 11f).
 *
 * It is NOT under the `(student)` group, and cannot be: that layout calls
 * `requireUser`, which bounces exactly this account here. So it lives in its
 * own group with no shell — which is also the right thing to show. There is
 * no navigation to offer: until this form is submitted, every other page in
 * the product refuses.
 *
 * Nobody else sees it. An account whose password is already its own is sent
 * home, where Profile → Settings has the ordinary change (current, then
 * new).
 */
export default async function NewPasswordPage() {
  const user = await requireUserSettingInitialPassword();
  if (!user.mustChangePassword) redirect(homeForRole(user.role));

  return (
    <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-md px-4 py-10 outline-none sm:py-16">
      <div className="rounded-2xl border border-border bg-surface p-6 shadow-card sm:p-8">
        <div className="flex items-center gap-2 text-primary">
          <KeyRound className="h-5 w-5" aria-hidden />
          <span className="text-sm font-semibold">{PRODUCT_NAME}</span>
        </div>
        <h1 className="mt-3 font-display text-2xl font-bold tracking-tight">Set your own password</h1>
        <p className="mt-1 text-sm text-text-secondary">
          You signed in with the password your department gave you, {user.firstName}. That one may have been given to
          your whole class, so choose your own before you go on. Nobody else can see what you pick.
        </p>

        <div className="mt-6">
          <FirstPasswordForm minLength={PASSWORD_MIN_LENGTH} />
        </div>
      </div>
    </main>
  );
}
