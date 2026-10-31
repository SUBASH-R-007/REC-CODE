import type { Metadata } from "next";
import Link from "next/link";
import { Mail } from "lucide-react";
import { Button, Field, Input } from "@recx/design";
import { FORGOT_SENT, forgotErrorMessage } from "@/lib/auth/reset-errors";
import { COLLEGE_NAME, LMS_NAME, PRODUCT_NAME } from "@/lib/brand/names";

export const metadata: Metadata = {
  title: "Set a new password",
  description: `Ask for a one-time link to set your ${PRODUCT_NAME} password.`,
  robots: { index: false, follow: false },
};

const MESSAGE_ID = "forgot-message";

/**
 * `/forgot-password` — ask for a one-time link.
 *
 * Public, like the sign-in page, and a plain form for the same reason: the
 * people most likely to need it are the ones who have never signed in, on
 * the worst connection in the hostel. It is a server component with no
 * client code, so it needs no JavaScript to work.
 *
 * The page says the same thing whether or not the identifier has an
 * account (`?sent=1`), because the alternative is a way to find out who
 * studies here. The only refusals it reports are about the form itself.
 */
export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string }>;
}) {
  const query = await searchParams;
  const sent = query.sent === "1";
  const error = forgotErrorMessage(query.error);

  return (
    <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-md px-4 py-10 outline-none sm:py-16">
      <div className="rounded-2xl border border-border bg-surface p-6 shadow-card sm:p-8">
        <h1 className="font-display text-2xl font-bold tracking-tight">Set a new password</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Tell us your roll number or college email and we will send a one-time link to your college address.
        </p>

        {sent ? (
          <p
            id={MESSAGE_ID}
            role="status"
            className="mt-6 rounded-xl border border-success/25 bg-success-subtle px-3.5 py-3 text-sm text-success"
          >
            {FORGOT_SENT}
          </p>
        ) : (
          <form method="post" action="/api/auth/forgot-password" className="mt-6 space-y-4">
            <Field label="Roll number or college email" htmlFor="identifier">
              <Input
                id="identifier"
                name="identifier"
                type="text"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                required
                maxLength={254}
                placeholder="Roll number or you@rajalakshmi.edu.in"
                autoFocus
                {...(error ? { "aria-describedby": MESSAGE_ID, "aria-invalid": true } : {})}
              />
            </Field>

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
              <Mail className="h-4 w-4" aria-hidden />
              Send me a link
            </Button>
          </form>
        )}

        <div className="mt-6 space-y-3 border-t border-border pt-5 text-sm text-text-secondary">
          <p>
            {/* /login is the Pages Router page, so this is a real navigation either way. */}
            <Link href="/login" className="font-medium text-primary underline-offset-2 hover:underline">
              Back to sign in
            </Link>
          </p>
          <p>
            No college address on your account, or the link never arrives? Your {PRODUCT_NAME} account comes from the{" "}
            {LMS_NAME} roster — ask your department coordinator.
          </p>
        </div>
      </div>
      <p className="mt-6 text-center text-xs text-muted">
        {PRODUCT_NAME} · {COLLEGE_NAME}
      </p>
    </main>
  );
}
