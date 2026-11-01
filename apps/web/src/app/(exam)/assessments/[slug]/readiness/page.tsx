import {
  SEB_CONFIG_KEY_HEADER,
  SEB_REFUSAL_MESSAGES,
  SEB_REQUEST_HASH_HEADER,
  isFinished,
  paperLanguageViews,
  paperQuestionCount,
  requiresDeviceAssertion,
  sebLaunchUrl,
  type AttemptStatus,
} from "@recx/shared";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/guards";
import { CollegeLogo } from "@/components/brand/college-logo";
import { db } from "@/lib/db";
import { pageRequest } from "@/lib/exam/containment";
import { acceptedLanguagesFor } from "@/lib/exam/language";
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
      sitInPopup: true,
      /** Which languages the programs may be answered in (Phase 13a). */
      allowedLanguages: true,
      id: true,
      maxAttempts: true,
      affectsPlacementEligibility: true,
      _count: { select: { problems: true, mcqs: true } },
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

  /**
   * The languages the programs may be answered in (Phase 13a).
   *
   * Said BEFORE the clock starts, which is the whole reason it is here: a
   * candidate who revises in Python and finds out at minute one that the
   * paper is C++ has lost the only moment they could have done anything
   * about it. The same intersection the sitting itself will freeze, so
   * this cannot promise a language the paper will not accept.
   */
  const accepted = assessment._count.problems > 0 ? await acceptedLanguagesFor(assessment.allowedLanguages) : [];
  const acceptedLabels = paperLanguageViews(accepted).map((language) => language.shortLabel);

  const proctorNote =
    assessment.proctorMode === "LAB_SUPERVISED"
      ? "This assessment is sat in a supervised lab. Your invigilator will seat you before you start."
      : assessment.proctorMode === "KIOSK_SEB"
        ? "This assessment runs in Safe Exam Browser. Start it from the kiosk build, not from an ordinary browser."
        : null;

  /**
   * Whether there is anything left to start (Phase 12t).
   *
   * A candidate who had handed their paper in was still shown the whole
   * readiness form: four checks and a consent box, and only after doing all
   * of them did pressing Start tell them they had already finished. Found
   * by the exam journey, whose last step could not press a button that the
   * checks had not yet enabled. The server still decides — this is the same
   * question asked early enough to be useful, and the honest answer to
   * somebody re-opening the link is a sentence, not a form.
   */
  const latest = await db.assessmentAttempt.findFirst({
    where: { assessmentId: assessment.id, userId: user.id },
    orderBy: { attemptNumber: "desc" },
    select: { status: true, attemptNumber: true },
  });
  const spent = latest?.attemptNumber ?? 0;
  const over =
    latest !== null && isFinished(latest.status as AttemptStatus) && spent >= assessment.maxAttempts;

  /**
   * Safe Exam Browser, before anything else (Phase 12y.8).
   *
   * A kiosk paper refused at Start with "open the exam from the .seb file
   * your department gave you" — and this product produced no such file,
   * so the sentence named something that did not exist. It does now, and
   * the candidate gets the one thing that actually helps: a link that
   * opens the exam IN Safe Exam Browser, with the plain download beside it
   * for a machine that does not know the `seb:` scheme.
   *
   * Until SEB is verified the checks and the Start button are not drawn at
   * all. The server would refuse the start anyway, but walking somebody
   * through four readiness checks and a consent box before telling them
   * they are in the wrong browser is a waste of the ten minutes before an
   * exam.
   */
  const kiosk = assessment.proctorMode === "KIOSK_SEB";
  const here = await pageRequest(`/assessments/${slug}/readiness`);
  const origin = new URL(here.url).origin;
  /**
   * The panel asks ONE question: is this request coming from Safe Exam
   * Browser at all?
   *
   * Not "are the keys right" — that is the start route's job, and it is
   * the only place that can answer it: the keys are per hall, and which
   * hall a candidate is seated in is decided when the sitting starts
   * (`pickHall`). A readiness page that verified against the college-wide
   * pair would tell a department that keys their halls individually that
   * nothing is configured, every time, on a page where the right answer
   * was "you are in the wrong browser".
   *
   * So: no SEB headers, no checks and no Start — here is the file. With
   * headers, the form renders and the start route gives the authoritative
   * answer, including the setup problem if there is one.
   */
  const inSeb =
    here.headers.get(SEB_CONFIG_KEY_HEADER) !== null || here.headers.get(SEB_REQUEST_HASH_HEADER) !== null;
  const sebOk = !kiosk || inSeb;

  const refusal = over
    ? START_REFUSAL_MESSAGES[spent === 1 && assessment.maxAttempts === 1 ? "finished" : "no_attempts_left"]
    : refused && refused in START_REFUSAL_MESSAGES
      ? START_REFUSAL_MESSAGES[refused as StartRefusal]
      : null;

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
        {/**
          * The college's mark, on the checks and NOT inside the sitting
          * (Phase 13b).
          *
          * This is the page where a candidate confirms what they are about
          * to sit, and whose paper it is belongs on it. The sitting itself
          * gets nothing: SPEC §5 keeps that screen to the question, the
          * clock and the answer, and a logo in an exam is one more thing
          * competing with a paper somebody is being marked on.
          */}
        <div className="mb-4">
          <CollegeLogo size="sm" />
        </div>
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
        {acceptedLabels.length > 0 ? (
          <p className="mt-3 text-sm text-text">
            {acceptedLabels.length === 1 ? (
              <>
                The programs on this paper are answered in <strong>{acceptedLabels[0]}</strong>.
              </>
            ) : (
              <>
                You may answer the programs in <strong>{acceptedLabels.join(", ")}</strong>, and choose per question
                once you have started.
              </>
            )}
          </p>
        ) : null}
        {accommodation && (accommodation.extraTimePercent > 0 || accommodation.extraTimeMinutes > 0) ? (
          <p className="mt-3 text-sm text-text">
            Your approved extra time is included: you have {minutes} minutes.
          </p>
        ) : null}
      </div>

      {kiosk && !sebOk ? (
        <div className="space-y-4 px-6 pb-10">
          <div className="rounded-xl border border-warning/40 bg-warning-subtle p-4 text-sm">
            <h3 className="font-display text-base font-semibold">This paper is sat in Safe Exam Browser</h3>
            <p className="mt-2">{SEB_REFUSAL_MESSAGES.absent}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <a
              href={sebLaunchUrl(`${origin}/api/exam/seb-config/${slug}`)}
              className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              Open in Safe Exam Browser
            </a>
            <a
              href={`/api/exam/seb-config/${slug}`}
              className="rounded-md border border-border px-3 py-2 text-sm font-semibold text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              Download the .seb file
            </a>
          </div>
          <p className="text-xs text-muted">
            The first link hands the settings straight to Safe Exam Browser. If nothing happens, it is not installed on
            this machine — download the file and open it with Safe Exam Browser, or ask your invigilator. Your
            attempts are untouched either way; nothing has started.
          </p>
        </div>
      ) : over ? (
        <div className="px-6 pb-10">
          <p className="text-sm text-text-secondary">
            Nothing more to do here. Your result appears on your assessment list when it is published.
          </p>
        </div>
      ) : (
        <ReadinessCheck
          slug={slug}
          durationMinutes={minutes}
          /**
           * Both kinds (Phase 12s). Counting only the coding questions told a
           * candidate with multiple-choice questions on their paper the wrong
           * number before they started — the fourth place that mistake was
           * made, which is why the rule is `paperQuestionCount` now.
           */
          questionCount={paperQuestionCount({
            problems: { length: assessment._count.problems },
            mcqs: { length: assessment._count.mcqs },
          })}
          proctorNote={proctorNote}
          /**
           * Whether this paper needs a registered device at all (Phase 12t).
           *
           * The device step used to find that out only when the candidate
           * pressed "Check my device" — so on a paper that needs no device,
           * every candidate was shown a paragraph saying their assessment was
           * bound to a machine their department enrolled (it is not), and the
           * Start button stayed disabled until they pressed a button about
           * it. Found by the exam journey, which could not get past it. The
           * mode is on this page already; the server still decides at start.
           */
          needsDevice={requiresDeviceAssertion(assessment.proctorMode)}
          sitInPopup={assessment.sitInPopup}
        />
      )}
    </div>
  );
}
