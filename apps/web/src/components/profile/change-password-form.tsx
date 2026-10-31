"use client";

import { useActionState } from "react";
import { KeyRound } from "lucide-react";
import { Button, Field, Input } from "@recx/design";
import { changeMyPassword } from "@/server/actions/profile";

/**
 * Change a password you already know. A real form bound to the action, so
 * it submits before hydration like the settings form beside it.
 *
 * It says what will happen before it happens: changing a password ends
 * every session of the account, including this one, and the person lands
 * back on the sign-in page. That is deliberate — somebody changing their
 * password because another person has it should not leave that person
 * signed in — and it is the sort of thing a form must not spring on
 * anybody.
 */
export function ChangePasswordForm({ minLength }: { minLength: number }) {
  const [state, formAction, pending] = useActionState(changeMyPassword, null);
  const error = state && !state.ok ? state.error : null;

  return (
    <form action={formAction} className="space-y-4" aria-busy={pending || undefined}>
      {error && (
        <p role="alert" className="rounded-xl border border-danger/25 bg-danger-subtle px-3.5 py-2.5 text-sm text-danger">
          {error}
        </p>
      )}

      <Field label="Current password" htmlFor="current">
        <Input id="current" name="current" type="password" autoComplete="current-password" required maxLength={1024} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="New password" htmlFor="next" hint={`At least ${minLength} characters, with a letter and a number.`}>
          <Input
            id="next"
            name="next"
            type="password"
            autoComplete="new-password"
            required
            minLength={minLength}
            maxLength={1024}
          />
        </Field>
        <Field label="New password again" htmlFor="confirm">
          <Input
            id="confirm"
            name="confirm"
            type="password"
            autoComplete="new-password"
            required
            minLength={minLength}
            maxLength={1024}
          />
        </Field>
      </div>

      <p className="text-sm text-text-secondary">
        This signs you out everywhere, including here, so you will sign in again with the new password.
      </p>

      <Button type="submit" loading={pending}>
        {!pending && <KeyRound className="h-4 w-4" aria-hidden />}
        Change my password
      </Button>
    </form>
  );
}
