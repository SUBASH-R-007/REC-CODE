"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@recx/design";
import { setAssessmentResultsPublished } from "@/server/actions/admin-assessments";

/**
 * Releasing the marks to the candidates (Phase 12y).
 *
 * Deliberately two states and one button, with the consequence written out
 * beside it rather than implied: staff mark, check, and then release. The
 * paragraph is here because the person releasing is often not the person
 * who set the paper, and "47 candidates will be able to read their own
 * mark" is the fact they need before clicking, not after.
 */
export function ReleaseResults({
  assessmentId,
  publishedAt,
  candidates,
  provisional,
  needsAttention,
}: {
  assessmentId: string;
  publishedAt: Date | null;
  candidates: number;
  provisional: number;
  needsAttention: number;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const published = publishedAt !== null;

  const change = (next: boolean) => {
    setError(null);
    setDone(null);
    start(async () => {
      const result = await setAssessmentResultsPublished({ assessmentId, published: next });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDone(
        next
          ? "Released. Each candidate can now read their own mark, and nobody else's."
          : "Withdrawn. The candidates' page says their result is being checked.",
      );
      router.refresh();
    });
  };

  return (
    <div className="space-y-3">
      <p className="text-sm">
        {published ? (
          <>
            <strong>Released.</strong> Each candidate can read their own mark.
          </>
        ) : (
          <>
            <strong>Not released.</strong> These marks are staff&apos;s own: no candidate can see theirs yet.
          </>
        )}
      </p>

      {!published ? (
        <div className="space-y-2 rounded-xl border border-border p-4 text-sm">
          <p>
            Releasing lets <strong>{candidates}</strong> {candidates === 1 ? "candidate" : "candidates"} read their own
            mark and their own question-by-question breakdown. They never see another candidate&apos;s, a rank, or where
            they came in the cohort.
          </p>
          {provisional > 0 ? (
            <p className="text-warning">
              {provisional} {provisional === 1 ? "result is" : "results are"} still provisional — a question is being
              judged, so the mark can still go up. Releasing now means somebody reads a number that then changes.
            </p>
          ) : null}
          {needsAttention > 0 ? (
            <p className="text-danger">
              {needsAttention} {needsAttention === 1 ? "answer needs" : "answers need"} a person first: the judge failed
              on it, or the answer recorded was not one of the options shown. Releasing now marks those as nothing
              earned.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        {published ? (
          <Button type="button" variant="outline" loading={pending} onClick={() => change(false)}>
            Withdraw the results
          </Button>
        ) : (
          <Button type="button" loading={pending} onClick={() => change(true)}>
            Release the results to candidates
          </Button>
        )}
        {done ? (
          <p role="status" className="text-sm text-success">
            {done}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
