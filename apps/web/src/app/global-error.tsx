"use client";

import { TriangleAlert } from "lucide-react";
import { Button, Card, EmptyState } from "@recx/design";
import "./globals.css";

/**
 * Last-resort boundary: replaces the root layout when the layout itself
 * fails, so it renders its own <html>/<body>. The global stylesheet is
 * imported here so the verbatim tokens (REC purple, light scheme) still
 * apply — no hardcoded colours, and no dependency on the brand row that may
 * be what failed.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">
        <main className="app-backdrop flex min-h-dvh items-center justify-center px-4">
          <Card className="w-full max-w-md">
            <EmptyState
              icon={<TriangleAlert className="h-8 w-8" aria-hidden />}
              title="Something went wrong"
              description={
                error.digest
                  ? `An unexpected error occurred. Please try again — if it keeps happening, quote reference ${error.digest}.`
                  : "An unexpected error occurred. Please try again."
              }
              action={<Button onClick={reset}>Try again</Button>}
            />
          </Card>
        </main>
      </body>
    </html>
  );
}
