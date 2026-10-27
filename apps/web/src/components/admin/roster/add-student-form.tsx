"use client";

import { useActionState } from "react";
import { UserPlus } from "lucide-react";
import { Button, Field, Input } from "@recx/design";
import { addStudent } from "@/server/actions/admin-roster";

/**
 * One student, typed in. A real `<form>` bound to the server action, so it
 * submits before hydration; a refusal — a roll number already taken, a
 * cohort outside this admin's scope, a field the roster schema will not
 * accept — is shown above the fields in the plan's own words.
 *
 * The fields and their bounds are `rosterRowSchema`'s, and the names match
 * the CSV columns, so what an admin learns here is what a roster file
 * needs. Nothing about a password: an account arrives without one and its
 * owner sets it through the one-time link (docs/SECURITY.md §2).
 */
export function AddStudentForm({ batchYear, departmentCode }: { batchYear: number; departmentCode: string | null }) {
  const [state, formAction, pending] = useActionState(addStudent, null);
  const error = state && !state.ok ? state.error : null;

  return (
    <form action={formAction} className="space-y-4" aria-busy={pending || undefined}>
      {error && (
        <p role="alert" className="rounded-xl border border-danger/25 bg-danger-subtle px-3.5 py-2.5 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Roll number" htmlFor="collegeId" hint="4–32 letters or digits. The join key with the roster.">
          <Input id="collegeId" name="collegeId" required maxLength={32} autoCapitalize="characters" spellCheck={false} />
        </Field>
        <Field label="LMS user id" htmlFor="lmsUserId" hint="From REC Learning. Every roster row has one.">
          <Input id="lmsUserId" name="lmsUserId" required maxLength={64} spellCheck={false} />
        </Field>
      </div>

      <Field label="College email" htmlFor="email">
        <Input id="email" name="email" type="email" required maxLength={254} autoCapitalize="none" spellCheck={false} />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="First name" htmlFor="firstName">
          <Input id="firstName" name="firstName" required maxLength={80} />
        </Field>
        <Field label="Last name" htmlFor="lastName" hint="Leave blank if the roster has none.">
          <Input id="lastName" name="lastName" maxLength={80} />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Batch year" htmlFor="batchYear">
          <Input
            id="batchYear"
            name="batchYear"
            type="number"
            inputMode="numeric"
            min={2000}
            max={2100}
            required
            defaultValue={batchYear}
          />
        </Field>
        <Field label="Department" htmlFor="departmentCode" hint="2–10 letters, e.g. CSE.">
          <Input
            id="departmentCode"
            name="departmentCode"
            required
            maxLength={10}
            autoCapitalize="characters"
            spellCheck={false}
            defaultValue={departmentCode ?? ""}
          />
        </Field>
        <Field label="Section" htmlFor="section" hint="Optional.">
          <Input id="section" name="section" maxLength={4} autoCapitalize="characters" spellCheck={false} />
        </Field>
      </div>

      <Button type="submit" loading={pending}>
        {!pending && <UserPlus className="h-4 w-4" aria-hidden />}
        Add the student
      </Button>
    </form>
  );
}
