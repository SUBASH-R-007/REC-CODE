import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { formatCampusTime } from "@recx/shared";
import { requireUser } from "@/lib/auth/guards";
import { getStudentReport } from "@/server/queries/sitting-report";
import { AppealForm } from "@/components/student/appeal-form";

export const metadata: Metadata = { title: "Your sitting" };
export const dynamic = "force-dynamic";

/**
 * A student's own report on their own sitting (Phase 6e): `/sittings/[id]`.
 *
 * NOT `/assessments/[attemptId]/report`, which is where this started: the
 * exam group already owns `/assessments/[slug]/…`, and Next refuses two
 * different slug NAMES at the same path position. The build compiled anyway
 * and only `pnpm size` caught it, because it actually serves the build and
 * asks it for a page — a reminder that `next build` succeeding is not the
 * same as the app routing.
 *
 * "Sitting" is the word this codebase uses for an attempt throughout, so the
 * path reads as what it is.
 *
 * SPEC §5 asks for "the student's own report within 48h". This is readable
 * the moment the sitting ends — a student should not have to wait two days to
 * find out their result is being withheld, and nothing here needs a reviewer
 * to have looked first.
 *
 * What is NOT on this page, by SPEC §5: a band, a points total, an "integrity
 * score". "Never display a band or an 'integrity score' to students or
 * recruiters — it invites exactly the misreading we are preventing, and
 * penalises the honest student with the bad laptop while the competent cheater
 * scores a clean 0." `tests/repo/integrity-isolation.test.ts` scans the
 * student tree to keep it off.
 *
 * What IS on it: what was recorded, in plain words; the verdict and the
 * reviewer's written rationale; and the appeal, if there is one to make.
 */
export default async function SittingPage({ params }: { params: Promise<{ attemptId: string }> }) {
  const user = await requireUser();
  const { attemptId } = await params;
  const report = await getStudentReport({ attemptId, userId: user.id });
  if (!report) notFound();

  return (
    <div className="max-w-2xl p-6">
      <h1 className="font-display text-2xl font-semibold text-text">{report.assessmentTitle}</h1>
      <p className="mt-1 text-sm text-text-secondary">
        {report.submittedAt ? `Submitted ${formatCampusTime(report.submittedAt)}.` : "Not submitted."}
      </p>

      <p
        className={`mt-4 rounded-md border px-3 py-2 text-sm ${
          report.withheld
            ? "border-warning/40 bg-warning-subtle text-warning"
            : "border-success/40 bg-success-subtle text-success"
        }`}
      >
        {report.withheld
          ? `Your result is not on the public leaderboard while this is reviewed: ${report.state.toLowerCase()}. Your score itself is not affected, and nobody has decided anything about you yet.`
          : `${report.state}. Your result is published.`}
      </p>

      {report.withheld && !report.resolved ? (
        <p className="mt-2 text-xs text-text-secondary">
          If nobody reviews it by {formatCampusTime(report.reviewDeadline)}, it publishes automatically. Waiting for a
          review is not your problem to carry.
        </p>
      ) : null}

      <section className="mt-6">
        <h2 className="font-display text-base font-semibold text-text">What was recorded during your sitting</h2>
        <ul className="mt-2 flex flex-col gap-2">
          {report.recorded.map((line) => (
            <li key={line} className="rounded-lg border border-border bg-surface p-3 text-sm text-text">
              {line}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-text-secondary">
          Pasting is allowed and is recorded, not blocked — students legitimately paste their own earlier code and the
          sample input. The text you paste is never stored: only its size and a one-way fingerprint.
        </p>
      </section>

      {report.verdicts.length > 0 ? (
        <section className="mt-6">
          <h2 className="font-display text-base font-semibold text-text">What the reviewer decided, and why</h2>
          <ul className="mt-2 flex flex-col gap-2">
            {report.verdicts.map((verdict, index) => (
              <li key={index} className="rounded-lg border border-border bg-surface p-3">
                <p className="text-sm font-medium text-text">
                  {verdict.verdict === "CLEAR" ? "Cleared" : "Upheld"} · {formatCampusTime(verdict.decidedAt)}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-text-secondary">{verdict.rationale}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {report.appeal ? (
        <section className="mt-6">
          <h2 className="font-display text-base font-semibold text-text">Your appeal</h2>
          <p className="mt-1 text-sm text-text-secondary">
            Submitted {formatCampusTime(report.appeal.submittedAt)}.{" "}
            {report.appeal.outcome === "PENDING"
              ? `Two people who did not make the original decision will decide it by ${formatCampusTime(report.appeal.decideBy)}. If they do not, it resolves in your favour.`
              : report.appeal.outcome === "OVERTURNED"
                ? "Your appeal succeeded and the decision was overturned."
                : "Your appeal was not upheld."}
          </p>
        </section>
      ) : null}

      {report.canAppeal && report.flagId ? (
        <section className="mt-6">
          <h2 className="font-display text-base font-semibold text-text">Appeal this decision</h2>
          <p className="mt-1 text-sm text-text-secondary">
            You have 7 days. Two people who did not make the original decision will read it, and if either of them
            disagrees with it the decision is overturned.
          </p>
          <div className="mt-3">
            <AppealForm flagId={report.flagId} />
          </div>
        </section>
      ) : null}
    </div>
  );
}
