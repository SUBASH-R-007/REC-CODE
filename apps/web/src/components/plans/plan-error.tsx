"use client";

import { useEffect } from "react";
import { Button, ButtonLink } from "@recx/design";

/** Error boundary body for the /sheets and /learn trees (keeps the app shell). */
export function PlanError({
  error,
  reset,
  homeHref,
  homeLabel,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  homeHref: string;
  homeLabel: string;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="font-display text-2xl font-bold">This page could not load</h1>
      <p className="max-w-sm text-sm text-text-secondary">
        Something went wrong while loading study plans. Your progress is safe — please try again.
        {error.digest ? <span className="mt-1 block font-mono text-xs text-muted">Reference {error.digest}</span> : null}
      </p>
      <div className="flex gap-2">
        <Button onClick={reset}>Try again</Button>
        <ButtonLink href={homeHref} variant="outline">
          {homeLabel}
        </ButtonLink>
      </div>
    </div>
  );
}
