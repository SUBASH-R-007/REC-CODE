"use client";

import { useActionState, useState, useTransition } from "react";
import { Copy, KeyRound, ShieldCheck, ShieldOff, Smartphone } from "lucide-react";
import { Button, Field, Input } from "@recx/design";
import { TOTP_DIGITS } from "@recx/shared/totp";
import {
  beginSecondFactorEnrolment,
  confirmSecondFactor,
  regenerateRecoveryCodes,
  removeSecondFactor,
  type PendingEnrolment,
} from "@/server/actions/second-factor";

/**
 * Setting up an authenticator app on your own admin account (Phase 16j).
 *
 * Three states, and the page decides which by what is in the database:
 * nothing set up, a secret shown and waiting for one code, or set up. The
 * recovery codes appear exactly once, straight after confirming or
 * regenerating — they are only stored as sha256, so a page that could show
 * them again would be a page that had kept them.
 *
 * The deep import (`@recx/shared/totp`) rather than the package barrel is
 * deliberate: this is a client component, and the barrel pulls zod in.
 * Phase 16c measured a 41.6 KB regression from exactly that, and
 * `pnpm size` was the only thing that caught it.
 *
 * In `components/staff` and NOT `components/account`, although the page it
 * renders lives at `/account/two-factor`. That directory is what
 * `tests/repo/inactivity-copy.test.ts` enumerates as the copy a RESTRICTED
 * STUDENT reads, and every file in it is listed there; this one is read
 * only by an ADMIN or SUPER_ADMIN, so listing it would misdescribe that
 * list, and leaving it unlisted in that directory would quietly stop the
 * fence covering a file it is supposed to cover.
 */

/** The codes, shown once. */
function RecoveryCodes({ codes }: { codes: readonly string[] }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-6 rounded-xl border border-warning/30 bg-warning-subtle p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-text">
        <KeyRound className="h-4 w-4" aria-hidden />
        Your {codes.length} recovery codes
      </h3>
      <p className="mt-1 text-sm text-text-secondary">
        Save these somewhere that is not your phone. Each one works once, and this is the only time they are shown —
        only a one-way hash of them is stored, so nobody, including a super-admin, can read them back to you.
      </p>
      <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-sm">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-3"
        onClick={() => {
          // Best effort: a clipboard the browser refuses is not a failure
          // worth a message, because the codes are on the screen.
          void navigator.clipboard?.writeText(codes.join("\n")).then(
            () => setCopied(true),
            () => undefined,
          );
        }}
      >
        <Copy className="h-4 w-4" aria-hidden />
        {copied ? "Copied" : "Copy all"}
      </Button>
    </div>
  );
}

function Secret({ pending }: { pending: PendingEnrolment }) {
  const [state, formAction, busy] = useActionState(confirmSecondFactor, null);
  const error = state && !state.ok ? state.error : null;
  const codes = state && state.ok ? state.data.recoveryCodes : null;

  if (codes) {
    return (
      <>
        <p className="flex items-center gap-2 rounded-xl border border-success/25 bg-success-subtle px-3.5 py-2.5 text-sm text-success">
          <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden />
          Your authenticator app is set up. You will be asked for a code every time you sign in.
        </p>
        <RecoveryCodes codes={codes} />
      </>
    );
  }

  return (
    <div className="space-y-5">
      <ol className="space-y-4 text-sm text-text-secondary">
        <li>
          <strong className="text-text">1. Add an entry to your authenticator app.</strong> Any of them works — Google
          Authenticator, Microsoft Authenticator, Aegis, 1Password, Bitwarden. Choose &quot;enter a setup key&quot; and
          type this:
          <code className="mt-2 block rounded-lg border border-border bg-elevated px-3 py-2 font-mono text-base tracking-wider text-text">
            {pending.secretForTyping}
          </code>
          <span className="mt-2 block text-xs text-muted">
            Time-based, 6 digits, 30 seconds — which is what every app defaults to. If yours takes a link instead, this
            is the same thing:{" "}
            <code className="break-all font-mono text-[11px]">{pending.uri}</code>
          </span>
        </li>
        <li>
          <strong className="text-text">2. Type the code it shows.</strong> That is how you and the server both find out
          the entry is right — before your next sign-in depends on it.
        </li>
      </ol>

      <form action={formAction} className="space-y-3" aria-busy={busy || undefined}>
        {error && (
          <p role="alert" className="rounded-xl border border-danger/25 bg-danger-subtle px-3.5 py-2.5 text-sm text-danger">
            {error}
          </p>
        )}
        <Field label={`${TOTP_DIGITS}-digit code`} htmlFor="code">
          <Input
            id="code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={16}
            placeholder="000000"
            required
            autoFocus
            className="max-w-40 text-center font-mono text-lg tracking-[0.3em]"
          />
        </Field>
        <Button type="submit" loading={busy}>
          Turn it on
        </Button>
        <p className="text-xs text-muted">
          This setup expires in {pending.expiresInMinutes} minutes if you leave it. Nothing changes about signing in
          until you finish.
        </p>
      </form>
    </div>
  );
}

export function SecondFactorSetup({
  enrolled,
  recoveryCodesLeft,
}: {
  enrolled: boolean;
  recoveryCodesLeft: number;
}) {
  const [pending, setPending] = useState<PendingEnrolment | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, startTransition] = useTransition();

  const [fresh, regenerateAction, regenerating] = useActionState(
    async () => regenerateRecoveryCodes(),
    null as Awaited<ReturnType<typeof regenerateRecoveryCodes>> | null,
  );
  const [removed, removeAction, removing] = useActionState(removeSecondFactor, null);

  if (pending) return <Secret pending={pending} />;

  if (!enrolled || (removed && removed.ok)) {
    return (
      <div className="space-y-4">
        {removed?.ok && (
          <p role="status" className="rounded-xl border border-border bg-elevated px-3.5 py-2.5 text-sm text-text-secondary">
            Your authenticator app has been removed. Signing in needs only your password again.
          </p>
        )}
        <p className="flex items-start gap-2 text-sm text-text-secondary">
          <Smartphone className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          An authenticator app on your phone produces a 6-digit code that changes every 30 seconds. With one set up, a
          stolen password is not enough to sign in as you — and your account can release results, commit a roster
          import, run an export and act as another user.
        </p>
        {startError && (
          <p role="alert" className="rounded-xl border border-danger/25 bg-danger-subtle px-3.5 py-2.5 text-sm text-danger">
            {startError}
          </p>
        )}
        <Button
          type="button"
          loading={starting}
          onClick={() =>
            startTransition(async () => {
              setStartError(null);
              const result = await beginSecondFactorEnrolment();
              if (result.ok) setPending(result.data);
              else setStartError(result.error);
            })
          }
        >
          <ShieldCheck className="h-4 w-4" aria-hidden />
          Set up an authenticator app
        </Button>
      </div>
    );
  }

  const codes = fresh && fresh.ok ? fresh.data.recoveryCodes : null;
  const regenerateError = fresh && !fresh.ok ? fresh.error : null;
  const removeError = removed && !removed.ok ? removed.error : null;

  return (
    <div className="space-y-6">
      <p className="flex items-center gap-2 rounded-xl border border-success/25 bg-success-subtle px-3.5 py-2.5 text-sm text-success">
        <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden />
        An authenticator app is set up on this account.
      </p>

      <section>
        <h2 className="text-sm font-semibold">Recovery codes</h2>
        <p className="mt-1 text-sm text-text-secondary">
          {recoveryCodesLeft === 0
            ? "You have no unused recovery codes left. Generate a new set now — without one, losing your phone means asking a super-admin."
            : `${recoveryCodesLeft} unused. Generating a new set replaces every code you have, used or not.`}
        </p>
        {regenerateError && (
          <p role="alert" className="mt-2 rounded-xl border border-danger/25 bg-danger-subtle px-3.5 py-2.5 text-sm text-danger">
            {regenerateError}
          </p>
        )}
        <form action={regenerateAction} className="mt-3">
          <Button type="submit" variant="outline" size="sm" loading={regenerating}>
            <KeyRound className="h-4 w-4" aria-hidden />
            Generate a new set
          </Button>
        </form>
        {codes && <RecoveryCodes codes={codes} />}
      </section>

      <section className="border-t border-border pt-5">
        <h2 className="text-sm font-semibold">Remove it</h2>
        <p className="mt-1 text-sm text-text-secondary">
          A current code from the app is required, not your password: somebody holding your password and not your phone
          is exactly who this must refuse. A recovery code does not work here — removing the factor is a decision for
          the person who still has the app.
        </p>
        {removeError && (
          <p role="alert" className="mt-2 rounded-xl border border-danger/25 bg-danger-subtle px-3.5 py-2.5 text-sm text-danger">
            {removeError}
          </p>
        )}
        <form action={removeAction} className="mt-3 flex flex-wrap items-end gap-3" aria-busy={removing || undefined}>
          <Field label="Current code" htmlFor="remove-code">
            <Input
              id="remove-code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={16}
              placeholder="000000"
              required
              className="w-32 text-center font-mono tracking-[0.2em]"
            />
          </Field>
          <Button type="submit" variant="danger" loading={removing}>
            <ShieldOff className="h-4 w-4" aria-hidden />
            Remove
          </Button>
        </form>
      </section>
    </div>
  );
}
