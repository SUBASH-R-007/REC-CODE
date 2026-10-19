import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { START_REFUSAL_MESSAGES, type StartRefusal } from "@/lib/exam/start";
import { ReadinessCheck } from "@/components/exam/readiness-check";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Before you start",
  robots: { index: false, follow: false },
};

/**
 * The readiness check (Phase 6c): `/assessments/[slug]/readiness`.
 *
 * It is in the `(exam)` group — no sidebar, no leaderboard, no way out —
 * because a candidate is already in exam conditions when they reach it. It is
 * NOT an exam path for the service worker, which is correct: no sitting
 * exists yet and there is nothing stale to serve.
 *
 * Nothing here creates an attempt. The clock starts when the candidate
 * presses start on the arena page, not when they test their wifi.
 *
 * `?refused=` carries a refusal from the arena, so a candidate who cannot
 * start reads why here — "this assessment is not open" and "you have used all
 * your attempts" are different problems with different people to ask.
 */
export default async function ReadinessPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ refused?: string }>;
}) {
  const { slug } = await params;
  const { refused } = await searchParams;
  const user = await requireUser();

  const assessment = await db.assessment.findUnique({
    where: { slug },
    select: {
      title: true,
      instructions: true,
      durationSec: true,
      proctorMode: true,
      affectsPlacementEligibility: true,
      _count: { select: { problems: true } },
    },
  });
  if (!assessment) notFound();

  const accommodation = await db.accommodation.findFirst({
    where: { userId: user.id, status: "APPROVED", validUntil: { gt: new Date() } },
    select: { extraTimePercent: true, extraTimeMinutes: true },
    orderBy: { grantedAt: "desc" },
  });

  const minutes = Math.round(
    (assessment.durationSec * (1 + (accommodation?.extraTimePercent ?? 0) / 100)) / 60 +
      (accommodation?.extraTimeMinutes ?? 0),
  );

  const proctorNote =
    assessment.proctorMode === "LAB_SUPERVISED"
      ? "This assessment is sat in a supervised lab. Your invigilator will seat you before you start."
      : assessment.proctorMode === "KIOSK_SEB"
        ? "This assessment runs in Safe Exam Browser. Start it from the kiosk build, not from an ordinary browser."
        : null;

  const refusal =
    refused && refused in START_REFUSAL_MESSAGES ? START_REFUSAL_MESSAGES[refused as StartRefusal] : null;

  return (
    <div className="mx-auto max-w-2xl">
      {refusal ? (
        <p
          role="alert"
          className="mx-6 mt-6 rounded-md border border-danger/40 bg-danger-subtle px-3 py-2 text-sm text-danger"
        >
          {refusal}
        </p>
      ) : null}

      <div className="px-6 pt-6">
        <h2 className="font-display text-xl font-semibold text-text">{assessment.title}</h2>
        {assessment.affectsPlacementEligibility ? (
          <p className="mt-2 rounded-md border border-info/40 bg-info-subtle px-3 py-2 text-sm text-info">
            This result counts towards placement eligibility.
          </p>
        ) : null}
        <div
          className="prose-exam mt-4 text-sm leading-relaxed text-text-secondary"
          // The instructions are sanitised when the assessment is saved.
          dangerouslySetInnerHTML={{ __html: assessment.instructions }}
        />
        {accommodation && (accommodation.extraTimePercent > 0 || accommodation.extraTimeMinutes > 0) ? (
          <p className="mt-3 text-sm text-text">
            Your approved extra time is included: you have {minutes} minutes.
          </p>
        ) : null}
      </div>

      <ReadinessCheck
        slug={slug}
        durationMinutes={minutes}
        questionCount={assessment._count.problems}
        proctorNote={proctorNote}
      />
    </div>
  );
}
