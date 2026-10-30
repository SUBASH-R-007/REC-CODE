import type { Metadata } from "next";
import Link from "next/link";
import { PenLine } from "lucide-react";
import { Badge, Card, CardBody, CardHeader, EmptyState } from "@recx/design";
import {
  WRITTEN_ANSWER_STATUS_LABEL,
  WRITTEN_KIND_LABEL,
  WRITTEN_NOTICES,
  WRITTEN_PROMPT_STATUS_LABEL,
} from "@recx/shared";
import { requireUser } from "@/lib/auth/guards";
import { loadOpenPrompts } from "@/server/queries/written";

export const metadata: Metadata = { title: "Written answers" };

/**
 * `/written` — system-design and written questions, marked by a TA
 * against a published rubric (Phase 12i).
 *
 * The page says the two things that change how a student uses it before
 * it says anything else: the rubric is visible before they start, and the
 * mark counts for nothing anywhere else in the product.
 */
export default async function WrittenPage() {
  const user = await requireUser();
  const prompts = await loadOpenPrompts(user.id);
  const open = prompts.filter((prompt) => prompt.status === "PUBLISHED");
  const retired = prompts.filter((prompt) => prompt.status === "RETIRED");

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="font-display text-2xl font-bold tracking-tight">Written answers</h1>
        <p className="max-w-3xl text-sm text-text-secondary">
          Design questions and written ones, where the answer is the explanation rather than a program. A TA reads
          what you write and marks it against the rubric on the question — which you can read before you start.{" "}
          {WRITTEN_NOTICES.gradingCountsForNothing}
        </p>
      </header>

      <Card>
        <CardHeader title="Open questions" />
        <CardBody>
          {open.length === 0 ? (
            <EmptyState
              compact
              icon={<PenLine className="h-5 w-5" />}
              title="Nothing open yet"
              description="Questions appear here as TAs write them."
            />
          ) : (
            <ul className="space-y-3">
              {open.map((prompt) => (
                <li key={prompt.id} className="rounded-2xl border border-border bg-surface p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link href={`/written/${prompt.slug}`} className="font-display text-sm font-semibold hover:underline">
                        {prompt.title}
                      </Link>
                      <p className="mt-0.5 text-xs text-muted">
                        {WRITTEN_KIND_LABEL[prompt.kind]} · about {prompt.timeBoxMinutes} minutes
                      </p>
                    </div>
                    {prompt.mine ? (
                      <Badge tone={prompt.mine.status === "GRADED" ? "success" : undefined}>
                        {WRITTEN_ANSWER_STATUS_LABEL[prompt.mine.status]}
                        {prompt.mine.percent !== null ? ` · ${prompt.mine.percent}%` : ""}
                      </Badge>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {retired.length > 0 ? (
        <Card>
          <CardHeader
            title="Retired"
            subtitle="Withdrawn questions you answered. Your answer and its mark are kept."
          />
          <CardBody>
            <ul className="space-y-3">
              {retired.map((prompt) => (
                <li key={prompt.id} className="rounded-2xl border border-border bg-surface p-4">
                  <Link href={`/written/${prompt.slug}`} className="font-display text-sm font-semibold hover:underline">
                    {prompt.title}
                  </Link>
                  <p className="mt-0.5 text-xs text-muted">
                    {WRITTEN_PROMPT_STATUS_LABEL[prompt.status]}
                    {prompt.mine ? ` · ${WRITTEN_ANSWER_STATUS_LABEL[prompt.mine.status]}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
