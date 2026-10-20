import type { Metadata } from "next";
import { SearchX } from "lucide-react";
import { ButtonLink, Card, EmptyState } from "@recx/design";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="app-backdrop flex min-h-dvh items-center justify-center px-4 outline-none"
    >
      <Card className="w-full max-w-md">
        <EmptyState
          icon={<SearchX className="h-8 w-8" aria-hidden />}
          title="Page not found"
          description="This page doesn't exist. It may have been moved, or the link may be mistyped."
          action={<ButtonLink href="/">Back to home</ButtonLink>}
        />
      </Card>
    </main>
  );
}
