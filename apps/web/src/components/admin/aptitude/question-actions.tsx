"use client";

import { useState, useTransition } from "react";
import { Button } from "@recx/design";
import { EXPLANATION_MIN_CHARS } from "@recx/shared";
import {
  retireAptitudeQuestion,
  reviseAptitudeExplanation,
  submitAptitudeQuestionForReview,
} from "@/server/actions/admin-aptitude";
import { publishAptitudeQuestion } from "@/server/actions/super-aptitude";

/**
 * The lifecycle of one question (Phase 7d).
 *
 * Four acts, and the differences between them are the design:
 *
 *   * submit for review — ADMIN, one press, reversible by publishing or not;
 *   * PUBLISH — SUPER_ADMIN, and the copy says what it does, because from
 *     that moment a cohort can be scored on the question and its wording is
 *     frozen. Not the primary button: publishing is the irreversible one;
 *   * retire — ADMIN with a WRITTEN REASON, because "this question is wrong"
 *     must not wait for a super-admin, and a student may ask to see why;
 *   * revise the explanation — allowed at every status, including published.
 *     Improving the working harms nobody and helps everybody who gets it
 *     wrong next.
 */

export function QuestionActions({
  questionId,
  status,
  canPublish,
  explanation,
}: {
  questionId: string;
  status: string;
  canPublish: boolean;
  explanation: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [working, setWorking] = useState(explanation);
  const [pending, start] = useTransition();

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, success: string) => {
    setError(null);
    setNote(null);
    start(async () => {
      const result = await fn();
      if (result.ok) setNote(success);
      else setError(result.error ?? "That did not work.");
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {status === "DRAFT" ? (
          <Button
            size="sm"
            loading={pending}
            onClick={() =>
              run(
                () => submitAptitudeQuestionForReview({ questionId }),
                "Sent for review. Somebody else has to read it before it can be published.",
              )
            }
          >
            Send for review
          </Button>
        ) : null}

        {canPublish && status === "IN_REVIEW" ? (
          <Button
            size="sm"
            variant="secondary"
            loading={pending}
            onClick={() =>
              run(
                () => publishAptitudeQuestion({ questionId }),
                "Published. A cohort can be scored on it now, and its wording, options and answer are frozen.",
              )
            }
          >
            Publish it
          </Button>
        ) : null}
      </div>

      {status === "PUBLISHED" || status === "IN_REVIEW" || status === "DRAFT" ? (
        <form
          className="space-y-2 rounded-md border border-border p-4"
          onSubmit={(event) => {
            event.preventDefault();
            run(
              () => retireAptitudeQuestion({ questionId, reason }),
              "Retired. It will not be served again, and it is not deleted — answer rows reference it and past results stay honest.",
            );
          }}
        >
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Retire this question</span>
            <span className="text-xs text-muted">
              Say why in a sentence. This is recorded, and a student may ask to see it. Retiring stops the question
              being served; it is never deleted.
            </span>
            <input
              type="text"
              value={reason}
              minLength={10}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
              className="h-9 rounded-md border border-border bg-surface px-3"
              placeholder="The second option is also correct, so the key is wrong."
            />
          </label>
          <Button type="submit" size="sm" variant="danger" loading={pending} disabled={reason.trim().length < 10}>
            Retire it
          </Button>
        </form>
      ) : null}

      <form
        className="space-y-2 rounded-md border border-border p-4"
        onSubmit={(event) => {
          event.preventDefault();
          run(
            () => reviseAptitudeExplanation({ questionId, explanation: working }),
            "The worked explanation is updated. Everybody who gets this wrong from now on reads the better one.",
          );
        }}
      >
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Worked explanation</span>
          <span className="text-xs text-muted">
            Editable at every status, published included: students have already been scored on the question, so
            rewriting its key would rescore the past — while improving the working harms nobody.
          </span>
          <textarea
            value={working}
            rows={6}
            minLength={EXPLANATION_MIN_CHARS}
            maxLength={8_000}
            onChange={(event) => setWorking(event.target.value)}
            className="rounded-md border border-border bg-surface p-3"
          />
        </label>
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          loading={pending}
          disabled={working.trim().length < EXPLANATION_MIN_CHARS}
        >
          Save the explanation
        </Button>
      </form>

      {error ? (
        <p role="alert" className="rounded-md border border-danger/30 bg-danger-subtle p-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
      {note ? (
        <p role="status" className="rounded-md border border-success/30 bg-success-subtle p-3 text-sm text-success">
          {note}
        </p>
      ) : null}
    </div>
  );
}
