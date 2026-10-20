import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";
import { msRemaining } from "@recx/shared";
import { requireUser } from "@/lib/auth/guards";
import { SESSION_COOKIE, hashSessionToken } from "@/lib/auth/session-token";
import { db } from "@/lib/db";
import { startOrResumeAttempt } from "@/lib/exam/start";
import { ExamSession } from "@/components/exam/exam-session";
import { getExamPaper } from "@/server/queries/exam";

export const dynamic = "force-dynamic";

/** Nothing about a sitting belongs in a search index or a browser title bar. */
export const metadata: Metadata = {
  title: "Assessment",
  robots: { index: false, follow: false },
};

/**
 * The arena (Phase 6c): `/assessments/[slug]/attempt`.
 *
 * The path matters — it is already an exam path in
 * `components/pwa/sw-routes.ts`, so the service worker refuses to intercept
 * it and unregisters itself when it is navigated to. "A stale cached shell
 * must never serve an exam" (SPEC §5).
 *
 * Starting and resuming are the SAME request. A candidate who reloads, whose
 * laptop died, or who was bounced by a flaky network arrives here again and
 * gets back the paper they already had, with the deadline unchanged —
 * `startOrResumeAttempt` returns the stored row rather than recomputing
 * anything, because `seed`, `layout`, `startedAt` and `expiresAt` are
 * write-once in the database.
 */
export default async function AttemptPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await requireUser();

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = token
    ? await db.session.findUnique({ where: { tokenHash: hashSessionToken(token) }, select: { id: true } })
    : null;

  const started = await startOrResumeAttempt({ slug, userId: user.id, sessionId: session?.id ?? null });
  if (!started.ok) {
    if (started.refusal === "not_found") notFound();
    // Back to the readiness page, which is where a candidate can read why and
    // what to do about it. Carrying the reason rather than a bare redirect:
    // "this assessment is not open" and "you have used all your attempts" are
    // different problems with different people to ask.
    redirect(`/assessments/${slug}/readiness?refused=${started.refusal}`);
  }

  const { attempt, layout } = started;
  const paper = await getExamPaper(layout);
  if (paper.missing.length > 0) {
    console.error(
      `[exam] attempt ${attempt.id}: ${paper.missing.length} of ${layout.questions.length} questions could not be read`,
    );
  }

  const assessment = await db.assessment.findUniqueOrThrow({
    where: { id: attempt.assessmentId },
    select: { proctorMode: true },
  });

  // Any work recovered from this browser's write-ahead store is merged on the
  // client, where IndexedDB lives; the server contributes the last snapshot it
  // holds so a candidate who moved machines is not sent back to the starter.
  const latestSnapshots = await db.attemptSnapshot.findMany({
    where: { attemptId: attempt.id },
    orderBy: [{ atMs: "desc" }],
    select: { questionId: true },
    distinct: ["questionId"],
  });
  const recovered: Record<string, string> = {};
  for (const { questionId } of latestSnapshots) {
    const { readSnapshotTimeline } = await import("@/lib/exam/snapshots");
    const timeline = await readSnapshotTimeline({ attemptId: attempt.id, questionId });
    const last = timeline[timeline.length - 1];
    // A version whose hash did not verify is NOT handed back as the
    // candidate's work; the starter is safer than a wrong reconstruction.
    if (last?.verified) recovered[questionId] = last.source;
  }

  return (
    <ExamSession
      attemptId={attempt.id}
      questions={paper.questions}
      initialMsRemaining={msRemaining({
        expiresAt: attempt.expiresAt,
        pausedMs: attempt.pausedMs,
        now: new Date(),
      })}
      initialStatus={attempt.status}
      candidate={{
        name: `${user.firstName} ${user.lastName}`.trim(),
        section: [user.departmentCode, user.section].filter(Boolean).join(" · ") || null,
      }}
      labSupervised={assessment.proctorMode === "LAB_SUPERVISED"}
      initialSources={recovered}
    />
  );
}
