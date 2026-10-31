import type { Metadata } from "next";
import { KeyRound } from "lucide-react";
import { Button, Field, Input } from "@recx/design";
import { PASSWORD_MIN_LENGTH } from "@/lib/auth/password";
import { RESET_TTL_MINUTES } from "@/lib/auth/password-reset";
import { resetErrorMessage } from "@/lib/auth/reset-errors";
import { COLLEGE_NAME, PRODUCT_NAME } from "@/lib/brand/names";

export const metadata: Metadata = {
  title: "Choose a password",
  description: `Set the password of your ${PRODUCT_NAME} account.`,
  robots: { index: false, follow: false },
};

const MESSAGE_ID = "reset-message";

/**
 * `/reset-password?token=…` — spend the link and choose a password.
 *
 * The token stays in the query and travels on in a hidden field, which is
 * what makes the page work without JavaScript and without a session. Two
 * consequences are deliberate: the page is `noindex` (it is also
 * unguessable, but a crawler should never hold one), and it does NOT check
 * the token before showing the form. Checking first would mean saying
 * "expired" to anybody who presents a string — a free oracle for walking
 * tokens — while saying nothing costs a legitimate visitor one submit.
 *
 * A token is never rendered anywhere a human reads: it is a hidden input,
 * not shown, not logged.
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const query = await searchParams;
  const token = typeof query.token === "string" ? query.token.slice(0, 128) : "";
  const error = resetErrorMessage(query.error);

  return (
    <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-md px-4 py-10 outline-none sm:py-16">
      <div className="rounded-2xl border border-border bg-surface p-6 shadow-card sm:p-8">
        <h1 className="font-display text-2xl font-bold tracking-tight">Choose a password</h1>
        <p className="mt-1 text-sm text-text-secondary">
          It replaces any password this account had, and signs the account out everywhere else.
        </p>

        {token.length === 0 ? (
          <p
            role="alert"
            className="mt-6 rounded-xl border border-danger/25 bg-danger-subtle px-3.5 py-3 text-sm text-danger"
          >
            This page needs the link from your email. Open that link again, or{" "}
            <a href="/forgot-password" className="font-medium underline underline-offset-2">
              ask for a new one
            </a>
            .
          </p>
        ) : (
          <form method="post" action="/api/auth/reset-password" className="mt-6 space-y-4">
            <input type="hidden" name="token" value={token} />
            <Field label="New password" htmlFor="password">
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={PASSWORD_MIN_LENGTH}
                maxLength={1024}
                autoFocus
                {...(error ? { "aria-describedby": MESSAGE_ID, "aria-invalid": true } : {})}
              />
            </Field>
            <Field label="New password again" htmlFor="confirm">
              <Input
                id="confirm"
                name="confirm"
                type="password"
                autoComplete="new-password"
                required
                minLength={PASSWORD_MIN_LENGTH}
                maxLength={1024}
                {...(error ? { "aria-describedby": MESSAGE_ID } : {})}
              />
            </Field>

            <p className="text-sm text-text-secondary">
              At least {PASSWORD_MIN_LENGTH} characters, with a letter and a number.
            </p>

            {error && (
              <p
                id={MESSAGE_ID}
                role="alert"
                className="rounded-xl border border-danger/25 bg-danger-subtle px-3.5 py-2.5 text-sm text-danger"
              >
                {error}
              </p>
            )}

            <Button type="submit" className="w-full" size="lg">
              <KeyRound className="h-4 w-4" aria-hidden />
              Set my password
            </Button>
          </form>
        )}

        <p className="mt-6 border-t border-border pt-5 text-sm text-text-secondary">
          A link works once and lasts {RESET_TTL_MINUTES} minutes.{" "}
          <a href="/forgot-password" className="font-medium text-primary underline-offset-2 hover:underline">
            Ask for another
          </a>{" "}
          if yours has run out.
        </p>
      </div>
      <p className="mt-6 text-center text-xs text-muted">
        {PRODUCT_NAME} · {COLLEGE_NAME}
      </p>
    </main>
  );
}
