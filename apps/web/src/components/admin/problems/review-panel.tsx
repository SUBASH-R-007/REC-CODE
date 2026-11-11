"use client";

import { useId, useState } from "react";
import { Button, Field, Textarea } from "@recx/design";
import { approveVersion, returnToDraft, revokeVersionApproval, submitForReview, withdrawFromReview } from "@/server/actions/admin-problems";
import { useActionRunner } from "./use-action";

/**
 * Review actions for one revision, by stage:
 *   DRAFT      Submit for review (with the originality attestation)
 *   IN_REVIEW  Approve, Return to author (with a comment), Withdraw to draft
 *   APPROVED   Revoke approval (with a reason), Withdraw to draft
 * The server enforces every rule again (approver ≠ creator, last editor and
 * submitter; validation publishable; no content errors).
 */
export function ReviewPanel({
  versionId,
  stage,
  editSeq,
  selfReview,
}: {
  versionId: string;
  stage: "DRAFT" | "IN_REVIEW" | "APPROVED";
  editSeq: number;
  /** The viewer created, last edited or submitted this revision (cannot approve it). */
  selfReview: boolean;
}) {
  const id = useId();
  const { run, pending, error } = useActionRunner();
  const [attest, setAttest] = useState(false);
  const [comment, setComment] = useState("");

  if (stage === "DRAFT") {
    return (
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => submitForReview({ versionId, expectedEditSeq: editSeq, attestOriginal: attest, comment }), {
            success: (d) => `Revision ${d.revision} submitted for review.`,
          });
        }}
      >
        <label className="flex items-start gap-2 text-sm text-text">
          <input
            type="checkbox"
            checked={attest}
            onChange={(e) => setAttest(e.target.checked)}
            required
            className="mt-0.5 h-4 w-4 accent-primary"
          />
          <span>
            I confirm this content — statement, tests, solutions, hints and editorial — is originally authored for REC Code and
            not copied or paraphrased from LeetCode, GeeksforGeeks, InterviewBit or any other site.
          </span>
        </label>
        <Field label="Note for the reviewer (optional)" htmlFor={`${id}-note`}>
          <Textarea id={`${id}-note`} rows={2} maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)} />
        </Field>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <Button type="submit" loading={pending} disabled={!attest}>
          Submit for review
        </Button>
      </form>
    );
  }

  return (
    <div className="space-y-3">
      <Field
        label={stage === "APPROVED" ? "Why revoke the approval?" : "Comment (required to return it)"}
        htmlFor={`${id}-comment`}
        hint={stage === "APPROVED" ? "Recorded in the audit log." : "Shown to the author in the review history."}
      >
        <Textarea id={`${id}-comment`} rows={2} maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)} />
      </Field>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {stage === "IN_REVIEW" && (
          <>
            <Button
              type="button"
              loading={pending}
              disabled={selfReview}
              onClick={() => run(() => approveVersion({ versionId, comment }), { success: (d) => `Revision ${d.revision} approved.` })}
            >
              Approve
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => run(() => returnToDraft({ versionId, comment }), { success: "Returned to the author." })}
            >
              Return to author
            </Button>
          </>
        )}
        {stage === "APPROVED" && (
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => run(() => revokeVersionApproval({ versionId, reason: comment }), { success: "Approval revoked." })}
          >
            Revoke approval
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={() => run(() => withdrawFromReview({ versionId, comment }), { success: "Withdrawn to draft." })}
        >
          Withdraw to draft
        </Button>
      </div>
      {stage === "IN_REVIEW" && selfReview && (
        <p className="text-sm text-text-secondary">You created, edited or submitted this revision, so another admin must approve it.</p>
      )}
    </div>
  );
}
