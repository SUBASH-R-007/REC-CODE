import type { Metadata } from "next";
import { EmptyState } from "@recx/design";
import { requireUser } from "@/lib/auth/guards";
import { listMyAssessments } from "@/server/queries/assessments";
import { formatCampusTime } from "@recx/shared";

export const metadata: Metadata = { title: "Assessments" };

/**
 * `/assessments` — a student's own assessments (Phase 6c).
 *
 * The entry point into the exam shell, and deliberately the ONLY one: the
 * exam group has no navigation of its own, so a candidate reaches a sitting
 * from here and leaves it by finishing it.
 *
 * "Start" goes to the readiness check, never straight to the arena. The clock
 * starts on the arena page, and a student who clicks a link in a list has not
 * yet agreed to start a timed exam.
 */
export default async function AssessmentsPage() {
  const user = await requireUser();
  const assessments = await listMyAssessments(user);

  if (assessments.length === 0) {
    return (
      <div className="p-6">
        <h1 className="font-display text-2xl font-semibold text-text">Assessments</h1>
        <div className="mt-6">
          <EmptyState
            title="No assessments yet"
            description="Tests set for your batch, department and section appear here. Your department will tell you when one is scheduled."
          />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <h1 className="font-display text-2xl font-semibold text-text">Assessments</h1>
      <p className="mt-1 text-sm text-text-secondary">
        Tests set for you. Starting one starts its clock, so read the checks first.
      </p>

      <ul className="mt-6 flex flex-col gap-3">
        {assessments.map((assessment) => (
          <li
            key={assessment.slug}
            className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border bg-surface p-4"
          >
            <div className="min-w-0 flex-1">
              <p className="font-medium text-text">{assessment.title}</p>
              <p className="mt-1 text-xs text-text-secondary tabular-nums">
                {assessment.questionCount} {assessment.questionCount === 1 ? "question" : "questions"} ·{" "}
                {Math.round(assessment.durationSec / 60)} minutes · opens {formatCampusTime(assessment.opensAt)} ·
                closes {formatCampusTime(assessment.closesAt)}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {assessment.affectsPlacementEligibility ? (
                  <span className="rounded-full border border-info/40 bg-info-subtle px-2 py-0.5 text-xs text-info">
                    Counts towards placement
                  </span>
                ) : null}
                {assessment.proctorMode === "LAB_SUPERVISED" ? (
                  <span className="rounded-full border border-border px-2 py-0.5 text-xs text-text-secondary">
                    Supervised lab
                  </span>
                ) : null}
                {assessment.attempt ? (
                  <span className="rounded-full border border-border px-2 py-0.5 text-xs text-text-secondary">
                    Attempt {assessment.attempt.attemptNumber} of {assessment.maxAttempts} ·{" "}
                    {assessment.attempt.status.toLowerCase().replace(/_/g, " ")}
                  </span>
                ) : null}
              </div>
            </div>

            <Action slug={assessment.slug} action={assessment.action} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function Action({ slug, action }: { readonly slug: string; readonly action: string }) {
  // Start and resume both go to the readiness check: the arena is where the
  // clock starts, and a resume should still confirm the machine is working
  // before the candidate is dropped back into their paper.
  if (action === "start" || action === "resume") {
    return (
      <a
        href={`/assessments/${slug}/readiness`}
        className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {action === "resume" ? "Resume" : "Start"}
      </a>
    );
  }
  const label =
    action === "finished"
      ? "Finished"
      : action === "upcoming"
        ? "Not open yet"
        : action === "no_attempts_left"
          ? "No attempts left"
          : "Closed";
  return <span className="text-sm text-text-secondary">{label}</span>;
}
