import type { Metadata } from "next";
import Link from "next/link";
import { Inbox } from "lucide-react";
import { Badge, Card, CardBody, CardHeader, EmptyState } from "@recx/design";
import { WRITTEN_KIND_LABEL, WRITTEN_NOTICES, WRITTEN_PROMPT_STATUS_LABEL, formatCampusTime } from "@recx/shared";
import { requireMentorPage } from "@/lib/auth/guards";
import { loadAuthoredPrompts, loadGradingQueue } from "@/server/queries/written";
import { PromptActions } from "@/components/written/prompt-actions";
import { PromptForm } from "@/components/written/prompt-form";

export const metadata: Metadata = { title: "Written answers" };

/**
 * `/mentor/written` — the marking queue, the questions this TA wrote, and
 * the form for writing another (Phase 12i).
 *
 * The queue is shared rather than per-author: a question answered by
 * ninety students is not one person's evening, and the oldest submission
 * is first because the student who has waited longest is the one waiting.
 */
export default async function MentorWrittenPage() {
  const user = await requireMentorPage();
  const [queue, mine] = await Promise.all([loadGradingQueue(user.id), loadAuthoredPrompts(user.id)]);

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="font-display text-2xl font-bold tracking-tight">Written answers</h1>
        <p className="max-w-3xl text-sm text-text-secondary">
          Design and written questions, marked against the rubric published with them. The queue is shared — anybody
          marking can take the next one. {WRITTEN_NOTICES.gradingCountsForNothing}
        </p>
      </header>

      <Card>
        <CardHeader title="Waiting to be marked" subtitle="Oldest first." />
        <CardBody>
          {queue.length === 0 ? (
            <EmptyState compact icon={<Inbox className="h-5 w-5" />} title="Nothing waiting" description="The queue is empty." />
          ) : (
            <ul className="space-y-3">
              {queue.map((row) => (
                <li key={row.answerId} className="rounded-2xl border border-border bg-surface p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link href={`/mentor/written/${row.answerId}`} className="font-display text-sm font-semibold hover:underline">
                        {row.promptTitle}
                      </Link>
                      <p className="mt-0.5 text-xs text-muted">
                        {row.student} · {row.words} words · handed in {formatCampusTime(row.submittedAt)}
                      </p>
                    </div>
                    <Badge>{WRITTEN_KIND_LABEL[row.kind]}</Badge>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Questions you wrote" />
        <CardBody>
          {mine.length === 0 ? (
            <EmptyState compact title="None yet" description="Write one below; it starts as a draft." />
          ) : (
            <ul className="space-y-3">
              {mine.map((prompt) => (
                <li key={prompt.id} className="rounded-2xl border border-border bg-surface p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-display text-sm font-semibold">{prompt.title}</p>
                      <p className="mt-0.5 text-xs text-muted">
                        {WRITTEN_KIND_LABEL[prompt.kind]} · {prompt.criteria} criteria · {prompt.answers} answers
                        {prompt.waiting > 0 ? ` · ${prompt.waiting} waiting` : ""}
                      </p>
                    </div>
                    <Badge tone={prompt.status === "PUBLISHED" ? "success" : undefined}>
                      {WRITTEN_PROMPT_STATUS_LABEL[prompt.status]}
                    </Badge>
                  </div>
                  <div className="mt-3">
                    <PromptActions promptId={prompt.id} status={prompt.status} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Write a question"
          subtitle="The rubric is published with it, so write the rubric you would mark against."
        />
        <CardBody>
          <PromptForm />
        </CardBody>
      </Card>
    </div>
  );
}
