import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";
import { msRemaining } from "@recx/shared";
import { requireUser } from "@/lib/auth/guards";
import { checkPageContainment } from "@/lib/exam/containment";
import { readEditorPrefs } from "@/components/profile/settings-schema";
import { SESSION_COOKIE, hashSessionToken } from "@/lib/auth/session-token";
import { db } from "@/lib/db";
import { attemptLayoutOf } from "@/lib/exam/layout";
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

  /**
   * This page RENDERS a sitting; it does not create one. Starting mints an
   * attempt token and writes it to an httpOnly cookie, and Next refuses a
   * cookie write during a page render — so the arena used to die on its
   * first load with "Cookies can only be modified in a Server Action or
   * Route Handler", every time, for every candidate. `POST
   * /api/exam/start/[slug]` does the starting now (Phase 12a); a candidate
   * who arrives here without one is sent back to the readiness page, which
   * is where the button that starts it lives.
   */
  const assessment = await db.assessment.findUnique({ where: { slug }, select: { id: true, proctorMode: true, refuseOutsidePaste: true } });
  if (!assessment) notFound();
  const live = await db.assessmentAttempt.findFirst({
    where: { assessmentId: assessment.id, userId: user.id, status: { in: ["IN_PROGRESS", "DISCONNECTED"] } },
    orderBy: { attemptNumber: "desc" },
  });
  if (!live) redirect(`/assessments/${slug}/readiness`);
  void session;

  /**
   * The hall and Safe Exam Browser, checked HERE too (Phase 12y.7).
   *
   * Every request a sitting makes goes through `guardAttempt`, which runs
   * this — the heartbeat, each telemetry flush, each snapshot, the submit.
   * This page went through none of them: a signed-in user with an attempt
   * in progress, and then the paper. So a candidate who started a
   * KIOSK_SEB sitting inside Safe Exam Browser could open this same URL in
   * an ordinary browser and read every question, and a lab-supervised
   * paper could be read from anywhere. They could not submit from there,
   * but the questions were the thing worth taking.
   */
  const containment = await checkPageContainment({
    pathname: `/assessments/${slug}/attempt`,
    attempt: {
      id: live.id,
      userId: user.id,
      assessmentId: assessment.id,
      examSessionId: live.examSessionId,
      proctorMode: assessment.proctorMode,
    },
  });
  if (!containment.ok) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-4 p-6">
        <h1 className="font-display text-2xl font-semibold text-text">This paper cannot be opened here</h1>
        <p className="text-sm text-text-secondary">{containment.message}</p>
        <p className="text-sm text-text-secondary">
          Your sitting is safe and its clock is unchanged. Open it the way your department told you to, or ask your
          invigilator.
        </p>
        <p className="text-sm">
          <a href={`/assessments/${slug}/readiness`} className="text-primary underline-offset-2 hover:underline">
            ← Back to the checks
          </a>
        </p>
      </main>
    );
  }

  const attempt = live;
  const layout = attemptLayoutOf(attempt);
  const paper = await getExamPaper(layout);
  if (paper.missing.length > 0) {
    console.error(
      `[exam] attempt ${attempt.id}: ${paper.missing.length} of ${layout.questions.length} questions could not be read`,
    );
  }

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

  /**
   * The multiple-choice answers already recorded (Phase 12r), so a sitting
   * resumed in another tab or after a reload shows what was picked. They
   * live on the server from the moment they are picked, which is why there
   * is no write-ahead store for them the way there is for source.
   */
  const choices: Record<string, number> = {};
  if (paper.mcqs.length > 0) {
    for (const answer of await db.assessmentMcqAnswer.findMany({
      where: { attemptId: attempt.id },
      select: { mcqId: true, chosenIndex: true },
    })) {
      choices[answer.mcqId] = answer.chosenIndex;
    }
  }

  return (
    <ExamSession
      attemptId={attempt.id}
      questions={paper.questions}
      mcqs={paper.mcqs}
      initialChoices={choices}
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
      refuseOutsidePaste={assessment.refuseOutsidePaste}
      initialSources={recovered}
      editorPrefs={readEditorPrefs(user.editorPrefs)}
    />
  );
}
