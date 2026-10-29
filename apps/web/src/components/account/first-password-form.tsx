"use client";

import { useActionState } from "react";
import { KeyRound } from "lucide-react";
import { Button, Field, Input } from "@recx/design";
import { setMyFirstPassword } from "@/server/actions/profile";

/**
 * Replace the initial password (Phase 11f). A real form bound to the action,
 * so it submits before hydration — the people who see this page are on their
 * first ever sign-in, often on the worst connection in the hostel.
 *
 * It asks for no current password: the sign-in that sent them here already
 * took it. Asking again for a password a department read out in class
 * teaches nobody anything.
 */
export function FirstPasswordForm({ minLength }: { minLength: number }) {
  const [state, formAction, pending] = useActionState(setMyFirstPassword, null);
  const error = state && !state.ok ? state.error : null;

  return (
    <form action={formAction} className="space-y-4" aria-busy={pending || undefined}>
      {error && (
        <p role="alert" className="rounded-xl border border-danger/25 bg-danger-subtle px-3.5 py-2.5 text-sm text-danger">
          {error}
        </p>
      )}

      <Field
        label="New password"
        htmlFor="next"
        hint={`At least ${minLength} characters, with a letter and a number. Not the one you were given.`}
      >
        <Input id="next" name="next" type="password" autoComplete="new-password" required minLength={minLength} maxLength={1024} autoFocus />
      </Field>
      <Field label="New password again" htmlFor="confirm">
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required minLength={minLength} maxLength={1024} />
      </Field>

      <Button type="submit" loading={pending} className="w-full">
        {!pending && <KeyRound className="h-4 w-4" aria-hidden />}
        Save it and continue
      </Button>
    </form>
  );
}
