import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardBody, CardHeader, EmptyState } from "@recx/design";
import { WRITTEN_KIND_LABEL, formatCampusTime } from "@recx/shared";
import { requireMentorPage } from "@/lib/auth/guards";
import { loadForGrading } from "@/server/queries/written";
import { GradeForm } from "@/components/written/grade-form";
import { Rubric } from "@/components/written/rubric";

export const metadata: Metadata = { title: "Mark an answer" };

/**
 * `/mentor/written/[answerId]` — one answer, the question it answers, and
 * the rubric to mark it against (Phase 12i).
 *
 * All three on one page on purpose: a rubric a grader has to remember is
 * a rubric two graders apply differently. The answer is rendered with the
 * UNTRUSTED markdown renderer — it is a student's markdown, and this is
 * the one page in the product where a member of staff reads it.
 */
export default async function GradeWrittenAnswerPage({ params }: { params: Promise<{ answerId: string }> }) {
  const user = await requireMentorPage();
  const { answerId } = await params;
  const result = await loadForGrading(user.id, answerId);

  if (!result.ok) {
    if (result.status === 404) notFound();
    return (
      <div className="space-y-4">
        <h1 className="font-display text-2xl font-bold tracking-tight">Mark an answer</h1>
        <EmptyState
          title="Not this one"
          description={result.error}
          action={
            <Link href="/mentor/written" className="text-primary hover:underline">
              Back to the queue
            </Link>
          }
        />
      </div>
    );
  }

  const { view } = result;

  return (
    <div className="space-y-5">
      <header className="min-w-0">
        <h1 className="font-display text-2xl font-bold tracking-tight">{view.prompt.title}</h1>
        <p className="mt-1 text-sm text-text-secondary">
          {WRITTEN_KIND_LABEL[view.prompt.kind]} · {view.student} · handed in {formatCampusTime(view.submittedAt)}
        </p>
      </header>

      <Card>
        <CardHeader title="The question" />
        <CardBody>
          <div className="prose-recx text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: view.prompt.html }} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Their answer" />
        <CardBody>
          <div className="prose-recx text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: view.html }} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="The rubric" subtitle="The same list the student read before they wrote." />
        <CardBody>
          <Rubric criteria={view.prompt.criteria} outOf={view.prompt.outOf} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Mark it" />
        <CardBody>
          <GradeForm answerId={view.answerId} criteria={view.prompt.criteria} />
        </CardBody>
      </Card>
    </div>
  );
}
