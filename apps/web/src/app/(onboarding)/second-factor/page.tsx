import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { Button, Field, Input } from "@recx/design";
import { SECOND_FACTOR_MAX_ATTEMPTS, TOTP_DIGITS, TOTP_MESSAGES } from "@recx/shared";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { pendingChallenge, type SecondFactorFailure } from "@/lib/auth/second-factor";

export const metadata: Metadata = {
  title: "Enter your code",
  description: "Finish signing in with the code from your authenticator app.",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * `/second-factor` — the only page a half-finished sign-in can reach
 * (Phase 16j).
 *
 * The viewer has no session: they offered a correct password and owe a
 * code. What lets them see this page is the challenge cookie, and nothing
 * else — no challenge, no page, back to `/login`. It is in `(onboarding)`
 * rather than `(student)` or `(public)` for the same reason
 * `/account/new-password` is: those layouts call a guard, and this viewer
 * would be bounced by it, correctly.
 *
 * There is no navigation to offer. Until a code is typed, every other page
 * in the product refuses, which is the design — see
 * `lib/auth/second-factor.ts` for why no session exists yet.
 */
const MESSAGES: Record<SecondFactorFailure, string> = {
  "no-challenge": TOTP_MESSAGES.challengeExpired,
  "code-format": TOTP_MESSAGES.codeFormat,
  "code-wrong": TOTP_MESSAGES.codeWrong,
  "code-reused": TOTP_MESSAGES.codeReused,
  // A secret the server cannot read is an operational fault, not the
  // admin's: the key may have been rotated. The sentence says what to do
  // rather than what went wrong inside.
  "code-unreadable":
    "This account's authenticator setup cannot be read just now. Use a recovery code, or ask a super-admin.",
  "recovery-wrong": TOTP_MESSAGES.recoveryWrong,
  "too-many": TOTP_MESSAGES.tooManyAttempts,
};

const ERROR_ID = "second-factor-error";

export default async function SecondFactorPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[]; ref?: string | string[] }>;
}) {
  const challenge = await pendingChallenge();
  // Expired, exhausted, or never started: there is nothing to finish, and
  // `/login` is where it starts again. `pendingChallenge()` has already
  // deleted a dead row by here.
  if (!challenge) redirect("/login?error=second-factor-expired");

  const params = await searchParams;
  const raw = Array.isArray(params.error) ? params.error[0] : params.error;
  const error = raw && raw in MESSAGES ? MESSAGES[raw as SecondFactorFailure] : null;
  const left = Math.max(0, SECOND_FACTOR_MAX_ATTEMPTS - challenge.attempts);

  return (
    <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-md px-4 py-10 outline-none sm:py-16">
      <div className="rounded-2xl border border-border bg-surface p-6 shadow-card sm:p-8">
        <div className="flex items-center gap-2 text-primary">
          <ShieldCheck className="h-5 w-5" aria-hidden />
          <span className="text-sm font-semibold">{PRODUCT_NAME}</span>
        </div>
        <h1 className="mt-3 font-display text-2xl font-bold tracking-tight">One more step, {challenge.user.firstName}</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Your password was accepted. Open your authenticator app and enter the {TOTP_DIGITS} digits it shows for{" "}
          {PRODUCT_NAME}.
        </p>

        <form method="post" action="/api/auth/second-factor" className="mt-6 space-y-4">
          <Field label={`${TOTP_DIGITS}-digit code`} htmlFor="code">
            <Input
              id="code"
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 -]*"
              maxLength={16}
              placeholder="000000"
              autoFocus
              className="text-center font-mono text-lg tracking-[0.3em]"
              {...(error ? { "aria-describedby": ERROR_ID, "aria-invalid": true } : {})}
            />
          </Field>

          {error && (
            <p
              id={ERROR_ID}
              role="alert"
              className="rounded-xl border border-danger/25 bg-danger-subtle px-3.5 py-2.5 text-sm text-danger"
            >
              {error}
            </p>
          )}

          <Button type="submit" className="w-full" size="lg">
            Continue
          </Button>
          <p className="text-center text-xs text-muted">
            {left} {left === 1 ? "try" : "tries"} left before you have to sign in again.
          </p>
        </form>

        {/*
          The recovery path, second and quieter. It is a separate form rather
          than a second field on the first one: a browser that autofills a
          one-time code into the wrong box would otherwise spend a recovery
          code, and there are only ten of those.
        */}
        <details className="mt-6 border-t border-border pt-5">
          <summary className="cursor-pointer text-sm font-medium text-primary">
            Lost your phone? Use a recovery code
          </summary>
          <form method="post" action="/api/auth/second-factor" className="mt-4 space-y-3">
            <Field label="Recovery code" htmlFor="recoveryCode">
              <Input
                id="recoveryCode"
                name="recoveryCode"
                type="text"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                maxLength={32}
                placeholder="XXXX-XXXX-XXXX-XXXX"
                className="font-mono"
              />
            </Field>
            <Button type="submit" variant="outline" className="w-full">
              Use this recovery code
            </Button>
            <p className="text-xs text-muted">
              Each code works once. Using one counts against the same {SECOND_FACTOR_MAX_ATTEMPTS} tries, and your
              department can see in the audit log that one was used — never which.
            </p>
          </form>
        </details>
      </div>

      <p className="mt-6 text-center text-xs text-muted">
        {/*
          `next/link`, not a plain anchor: this is an App Router page and
          ships the router anyway. The sign-in page is the opposite case --
          it is Pages Router with no JavaScript at all, so an anchor there
          is correct and a router that cannot run is not worth the markup.
        */}
        <Link href="/login" className="font-medium text-primary underline-offset-2 hover:underline">
          Sign in as somebody else
        </Link>
      </p>
    </main>
  );
}
