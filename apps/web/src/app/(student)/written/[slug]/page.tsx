import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Badge, Card, CardBody, CardHeader } from "@recx/design";
import {
  WRITTEN_ANSWER_STATUS_LABEL,
  WRITTEN_KIND_LABEL,
  WRITTEN_NOTICES,
  formatCampusTime,
  scoreLine,
} from "@recx/shared";
import { requireUser } from "@/lib/auth/guards";
import { loadPromptForStudent } from "@/server/queries/written";
import { AnswerForm } from "@/components/written/answer-form";
import { Rubric } from "@/components/written/rubric";

export const metadata: Metadata = { title: "Written answer" };

/**
 * `/written/[slug]` — one question, its rubric, and the student's own
 * answer to it (Phase 12i).
 *
 * The rubric is above the box, not below it: it is what the answer is
 * marked against, so it is part of reading the question. A student who
 * has handed in sees their own words and waits; one who has been marked
 * sees the same rubric again with the marks on it, which is the point of
 * publishing it beforehand.
 */
export default async function WrittenPromptPage({ params }: { params: Promise<{ slug: string }> }) {
  const user = await requireUser();
  const { slug } = await params;
  const found = await loadPromptForStudent(user.id, slug);
  if (!found) notFound();
  const { prompt, answer } = found;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-bold tracking-tight">{prompt.title}</h1>
          <p className="mt-1 text-sm text-text-secondary">
            {WRITTEN_KIND_LABEL[prompt.kind]} · about {prompt.timeBoxMinutes} minutes · set by {prompt.author}
          </p>
        </div>
        {answer ? (
          <Badge tone={answer.status === "GRADED" ? "success" : undefined}>
            {WRITTEN_ANSWER_STATUS_LABEL[answer.status]}
          </Badge>
        ) : null}
      </header>

      <Card>
        <CardHeader title="The question" subtitle={WRITTEN_NOTICES.timeBox} />
        <CardBody>
          <div className="prose-recx text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: prompt.html }} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="What it is marked against" subtitle={WRITTEN_NOTICES.rubricVisible} />
        <CardBody>
          <Rubric criteria={prompt.criteria} outOf={prompt.outOf} marks={answer?.grade?.marks} />
        </CardBody>
      </Card>

      {answer?.grade ? (
        <Card>
          <CardHeader
            title={`Marked ${scoreLine(answer.grade)}`}
            subtitle={`By ${answer.grade.grader}, ${formatCampusTime(answer.grade.at)}.`}
          />
          <CardBody>
            <div
              className="prose-recx text-sm leading-relaxed"
              dangerouslySetInnerHTML={{ __html: answer.grade.html }}
            />
            <p className="mt-3 text-xs text-muted">{WRITTEN_NOTICES.gradingCountsForNothing}</p>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title={answer?.status === "SUBMITTED" ? "What you handed in" : "Your answer"}
          subtitle={
            answer?.status === "SUBMITTED"
              ? "Waiting for a TA to read it. Ask them to hand it back if you need to change it."
              : undefined
          }
        />
        <CardBody>
          {prompt.status !== "PUBLISHED" || answer?.status === "GRADED" || answer?.status === "SUBMITTED" ? (
            <pre className="scroll-thin max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-xl border border-border bg-background p-3 font-mono text-sm">
              {answer?.bodyMd ?? "You did not answer this one."}
            </pre>
          ) : (
            <AnswerForm
              promptId={prompt.id}
              initialBody={answer?.bodyMd ?? ""}
              handBackNote={answer?.handBackNote ?? null}
            />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
