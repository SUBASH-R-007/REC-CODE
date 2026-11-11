"use client";

import { useEffect } from "react";
import { TriangleAlert } from "lucide-react";
import { Button, ButtonLink, Card, EmptyState } from "@recx/design";

/**
 * Route-level error boundary. The server logs the full error under
 * `digest`; the student sees only that reference, never the message.
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="app-backdrop flex min-h-dvh items-center justify-center px-4 outline-none"
    >
      <Card className="w-full max-w-md">
        <EmptyState
          icon={<TriangleAlert className="h-8 w-8" aria-hidden />}
          title="Something went wrong"
          description={
            error.digest
              ? `An unexpected error occurred while loading this page. Please try again — if it keeps happening, quote reference ${error.digest}.`
              : "An unexpected error occurred while loading this page. Please try again."
          }
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={reset}>Try again</Button>
              <ButtonLink href="/" variant="outline">
                Back to home
              </ButtonLink>
            </div>
          }
        />
      </Card>
    </main>
  );
}
