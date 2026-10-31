import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { Badge, Card, CardBody, CardHeader, EmptyState } from "@recx/design";
import { MOCK_INTERVIEW_STATUS_LABEL, formatCampusTime } from "@recx/shared";
import { requireUser } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { loadMockSession } from "@/server/queries/mock-interviews";
import { CandidateRoom } from "@/components/mock/candidate-room";
import { InterviewerRoom } from "@/components/mock/interviewer-room";

export const metadata: Metadata = { title: "Mock interview" };

const idSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

/**
 * `/mock-interviews/[id]` — the room (Phase 12h).
 *
 * The SAME route for both people, and the server decides which half they
 * get. Two routes would be two places to get the authorisation right, and
 * the one thing this page must never do is show the interviewer's mirror
 * to anybody but the interviewer.
 *
 * A viewer who is neither gets a 404 rather than a 403: the existence of
 * somebody else's interview is not theirs to learn.
 */
export default async function MockRoomPage({ params }: { params: Promise<{ interviewId: string }> }) {
  const user = await requireUser();
  const parsed = idSchema.safeParse((await params).interviewId);
  if (!parsed.success) notFound();

  const session = await loadMockSession(user.id, parsed.data);
  if (!session) notFound();
  const { view, role } = session;

  if (view.status !== "IN_PROGRESS" && view.status !== "BOOKED") {
    return (
      <div className="space-y-4">
        <h1 className="font-display text-2xl font-bold tracking-tight">Mock interview</h1>
        <EmptyState
          title={MOCK_INTERVIEW_STATUS_LABEL[view.status]}
          description={
            view.cancelReason
              ? `Called off by ${view.cancelledBy}: ${view.cancelReason}`
              : "This one is over. The feedback, if there is any, is on your list."
          }
          action={
            <Link href={role === "MENTOR" ? "/mentor/mock-interviews" : "/mock-interviews"} className="text-primary hover:underline">
              Back to your interviews
            </Link>
          }
        />
      </div>
    );
  }

  const problems =
    role === "MENTOR"
      ? await db.problem.findMany({
          where: { status: "PUBLISHED", liveVersionId: { not: null } },
          orderBy: { displayCode: "asc" },
          take: 200,
          select: { id: true, displayCode: true, title: true, difficulty: true },
        })
      : [];

  const statement = view.problem
    ? await db.problem.findUnique({
        where: { slug: view.problem.slug },
        select: { liveVersion: { select: { statementMd: true, title: true } } },
      })
    : null;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-bold tracking-tight">Mock interview</h1>
          <p className="mt-1 text-sm text-text-secondary">
            {role === "MENTOR" ? `With ${view.candidate}` : `With ${view.mentor}`} ·{" "}
            {formatCampusTime(view.startsAt)} – {formatCampusTime(view.endsAt)}
          </p>
        </div>
        <Badge tone={view.status === "IN_PROGRESS" ? "primary" : undefined}>
          {MOCK_INTERVIEW_STATUS_LABEL[view.status]}
        </Badge>
      </header>

      {view.problem && statement?.liveVersion ? (
        <Card>
          <CardHeader title={`${view.problem.displayCode} · ${statement.liveVersion.title}`} />
          <CardBody>
            <pre className="scroll-thin max-h-64 overflow-auto whitespace-pre-wrap text-sm leading-relaxed text-text-secondary">
              {statement.liveVersion.statementMd}
            </pre>
          </CardBody>
        </Card>
      ) : null}

      {role === "CANDIDATE" ? (
        <CandidateRoom interviewId={view.id} running={view.status === "IN_PROGRESS"} />
      ) : (
        <InterviewerRoom
          interviewId={view.id}
          running={view.status === "IN_PROGRESS"}
          problems={problems}
          problemSet={view.problem !== null}
        />
      )}
    </div>
  );
}
