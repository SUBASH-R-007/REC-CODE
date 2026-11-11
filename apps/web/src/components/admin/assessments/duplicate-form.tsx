"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy } from "lucide-react";
import { Button, Field, Input, useToast } from "@recx/design";
import { duplicateAssessment } from "@/server/actions/admin-assessments";

/**
 * Set this paper again, for another section or another year (Phase 13l).
 *
 * The commonest thing a department does with an assessment, and the one
 * thing the product made them do by hand: every pinned problem looked up
 * again by address, every multiple-choice question retyped with its
 * options in order and its answer line. Slow, and the kind of slow that
 * produces a paper subtly different from the one it was meant to match.
 *
 * Four fields, because four things must differ: the name, the address,
 * and the two ends of the window. Everything else is the paper, and the
 * list below says what deliberately does not come with it — the copy is
 * a DRAFT with no halls, no keys and no moderation, and the person doing
 * this should know that before they click rather than after.
 */
export function DuplicateAssessmentForm({
  assessmentId,
  title,
  questions,
  halls,
}: {
  readonly assessmentId: string;
  readonly title: string;
  readonly questions: number;
  /** Halls are not copied; the sentence changes when there are some. */
  readonly halls: number;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        setError(null);
        start(async () => {
          const result = await duplicateAssessment({
            assessmentId,
            title: String(data.get("copyTitle") ?? ""),
            slug: String(data.get("copySlug") ?? ""),
            opensAt: String(data.get("copyOpensAt") ?? ""),
            closesAt: String(data.get("copyClosesAt") ?? ""),
          });
          if (!result.ok) {
            setError(result.error);
            return;
          }
          toast(
            `Copied with ${result.data.questions} ${result.data.questions === 1 ? "question" : "questions"}. It is a draft.`,
            "success",
          );
          router.push(`/admin/assessments/${result.data.id}`);
        });
      }}
    >
      <p className="text-sm text-text-secondary">
        A new DRAFT asking the same {questions} {questions === 1 ? "question" : "questions"} at the same pinned
        revisions, with {title}&apos;s terms, watching options, accepted languages and audience.
      </p>
      {error ? (
        <p role="alert" className="rounded-lg border border-danger/40 bg-danger-subtle p-2 text-sm text-danger">
          {error}
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Title" htmlFor="copyTitle">
          <Input id="copyTitle" name="copyTitle" required maxLength={160} defaultValue={`${title} (copy)`} />
        </Field>
        <Field label="Address" htmlFor="copySlug" hint="Lower-case words joined by hyphens, and not one in use.">
          <Input id="copySlug" name="copySlug" required maxLength={80} spellCheck={false} />
        </Field>
        <Field label="Opens" htmlFor="copyOpensAt" hint="Campus time (IST).">
          <Input id="copyOpensAt" name="copyOpensAt" type="datetime-local" required />
        </Field>
        <Field label="Closes" htmlFor="copyClosesAt" hint="Campus time (IST).">
          <Input id="copyClosesAt" name="copyClosesAt" type="datetime-local" required />
        </Field>
      </div>

      <ul className="list-disc space-y-1 pl-5 text-xs text-text-secondary">
        <li>
          The copy is a <strong>draft</strong>. Publishing it, and opening it for candidates, stay decisions somebody
          makes.
        </li>
        <li>
          {halls > 0
            ? `The ${halls} ${halls === 1 ? "hall" : "halls"} are not copied: a hall is a room, a clock and a network allowlist, and an inherited allowlist is a lab door left open.`
            : "Halls are not copied: a hall is a room, a clock and a network allowlist, so the copy gets its own."}
        </li>
        <li>
          Safe Exam Browser keys are not copied — a secret for one paper should not arrive somewhere nobody chose to
          put it.
        </li>
        <li>
          Nothing a sitting produced comes with it: no attempts, no marks, and no question left awarded or withdrawn
          by a decision about the first cohort.
        </li>
      </ul>

      <Button type="submit" variant="outline" loading={pending}>
        <Copy className="h-4 w-4" aria-hidden />
        Create the copy
      </Button>
    </form>
  );
}
