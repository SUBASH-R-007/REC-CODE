import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";
import { msRemaining } from "@recx/shared";
import { requireUser } from "@/lib/auth/guards";
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
  const assessment = await db.assessment.findUnique({ where: { slug }, select: { id: true, proctorMode: true } });
  if (!assessment) notFound();
  const live = await db.assessmentAttempt.findFirst({
    where: { assessmentId: assessment.id, userId: user.id, status: { in: ["IN_PROGRESS", "DISCONNECTED"] } },
    orderBy: { attemptNumber: "desc" },
  });
  if (!live) redirect(`/assessments/${slug}/readiness`);
  void session;

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
      editorPrefs={readEditorPrefs(user.editorPrefs)}
    />
  );
}
