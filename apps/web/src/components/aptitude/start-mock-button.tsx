"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@recx/design";
import { startMock } from "@/server/actions/aptitude";

/**
 * Starting — or resuming — a mock (Phase 7e).
 *
 * The clock starts on the SERVER, when the sitting row is created, so this
 * button cannot be the thing that decides when. It is also idempotent: a
 * candidate who double-clicks, or whose connection dropped on the way to the
 * first question, resumes the sitting they already have rather than ending up
 * with two papers and two clocks.
 *
 * The copy says plainly that the clock starts, because it does, and a button
 * that starts a timed paper without saying so is a button somebody presses by
 * accident.
 */
export function StartMockButton({ slug, liveAttemptId }: { slug: string; liveAttemptId: string | null }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const go = () => {
    setError(null);
    start(async () => {
      const result = await startMock({ slug });
      if (result.ok) router.push(`/aptitude/mock/attempt/${result.data.attemptId}`);
      else setError(result.error);
    });
  };

  return (
    <section className="space-y-3 rounded-xl border border-border p-4">
      {liveAttemptId ? (
        <>
          <p className="text-sm">
            You have a sitting of this mock in progress. Its clock has been running since you started it.
          </p>
          <Button onClick={() => router.push(`/aptitude/mock/attempt/${liveAttemptId}`)}>Go back to it</Button>
        </>
      ) : (
        <>
          <p className="text-sm">
            Pressing this starts the first section&apos;s clock. Everything above is how it is scored — read it first,
            because a section you leave does not come back.
          </p>
          <Button onClick={go} loading={pending}>
            Start the mock
          </Button>
        </>
      )}
      {error ? (
        <p role="alert" className="rounded-md border border-danger/30 bg-danger-subtle p-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}
