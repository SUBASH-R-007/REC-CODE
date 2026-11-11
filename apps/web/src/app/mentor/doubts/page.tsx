import type { Metadata } from "next";
import Link from "next/link";
import { MessagesSquare } from "lucide-react";
import { Badge, Card, CardBody, CardHeader, EmptyState } from "@recx/design";
import { formatCampusTime } from "@recx/shared";
import { requireMentorPage } from "@/lib/auth/guards";
import { loadOpenDoubts } from "@/server/queries/discussion";
import { MentorAnswerForm } from "@/components/discussion/mentor-answer-form";
import { HELP_PROSE } from "@/components/help/prose";

export const metadata: Metadata = { title: "Questions" };

/**
 * `/mentor/doubts` — every unanswered question, oldest first (Phase 12d).
 *
 * SPEC §9 gives a TA_MENTOR the power to "answer doubts with a badge". A
 * badge is worth nothing without somewhere to find the questions, and
 * asking mentors to browse problems hoping to stumble on one is how a help
 * channel dies in its second week. So: one list, college-wide, with the
 * oldest at the top, because what a student notices is how long nobody
 * replied.
 *
 * A thread leaves this list when the ASKER marks an answer — not when
 * somebody replies. "Somebody said something" is not "it was answered", and
 * only the person who was stuck can tell the difference.
 */
export default async function MentorDoubtsPage() {
  await requireMentorPage();
  const doubts = await loadOpenDoubts();

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="font-display text-2xl font-bold tracking-tight">Questions</h1>
        <p className="max-w-2xl text-sm text-text-secondary">
          Students who are stuck, oldest first. Your reply carries a TA / mentor badge. Point at the idea they are
          missing rather than pasting the answer — the solutions half of the discussion is for people who have already
          solved it, and a full answer here walks around that.
        </p>
      </header>

      <Card>
        <CardHeader
          title="Waiting"
          subtitle={doubts.length === 0 ? "Nothing open" : `${doubts.length} question${doubts.length === 1 ? "" : "s"}`}
        />
        <CardBody>
          {doubts.length === 0 ? (
            <EmptyState
              compact
              icon={<MessagesSquare className="h-5 w-5" />}
              title="Nothing is waiting"
              description="A question appears here the moment a student asks it, and leaves when they mark an answer."
            />
          ) : (
            <ol className="space-y-5">
              {doubts.map((thread) => (
                <li key={thread.id} className="rounded-2xl border border-border p-4">
                  <h2 className="font-display text-sm font-semibold">{thread.title}</h2>
                  <p className="mt-1 text-xs text-muted">
                    {thread.author} on{" "}
                    <Link href={`/problems/${thread.problemSlug}`} className="text-primary hover:underline">
                      {thread.problemTitle}
                    </Link>{" "}
                    · {formatCampusTime(thread.createdAt)}
                  </p>
                  <div className={`${HELP_PROSE} mt-2`} dangerouslySetInnerHTML={{ __html: thread.html }} />

                  {thread.replies.length > 0 && (
                    <ol className="mt-3 space-y-3 border-l-2 border-border pl-3">
                      {thread.replies.map((reply) => (
                        <li key={reply.id}>
                          <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
                            <span className="font-medium text-text-secondary">{reply.author}</span>
                            {reply.byMentor ? <Badge tone="primary">TA / mentor</Badge> : null}
                            <span>{formatCampusTime(reply.createdAt)}</span>
                          </p>
                          <div className={`${HELP_PROSE} mt-1`} dangerouslySetInnerHTML={{ __html: reply.html }} />
                        </li>
                      ))}
                    </ol>
                  )}

                  <MentorAnswerForm threadId={thread.id} title={thread.title} />
                </li>
              ))}
            </ol>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
