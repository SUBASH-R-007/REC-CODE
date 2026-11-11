import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { formatCampusTime } from "@recx/shared";
import { requireAdminScopePage } from "@/lib/auth/scope";
import { getFlagDetail } from "@/server/queries/admin-integrity";
import { AdminPageHeader } from "@/components/admin/admin-ui";
import { VerdictForm } from "@/components/admin/integrity/verdict-form";

export const metadata: Metadata = { title: "Review" };
export const dynamic = "force-dynamic";

/**
 * One flag, for the reviewer who is deciding it (Phase 6e).
 *
 * A reviewer DOES see the band and the points, unlike the invigilator and
 * unlike the student: they are deciding, and the queue order has to be
 * explainable to them. What they see alongside it is every caveat the spec
 * attaches to these signals, in the chips themselves — "a dropped connection
 * is not a finding", "a paste of sample input is normal" — because a number
 * presented without its limits is a number that gets over-read.
 */
export default async function FlagReviewPage({ params }: { params: Promise<{ flagId: string }> }) {
  await requireAdminScopePage();
  const { flagId } = await params;
  const flag = await getFlagDetail(flagId);
  if (!flag) notFound();

  const scored = flag.signals.filter((signal) => signal.points > 0 || signal.exempt);

  return (
    <div className="max-w-3xl">
      <AdminPageHeader
        title={`${flag.studentName} · ${flag.assessmentTitle}`}
        description={`${flag.collegeId}. Flagged ${formatCampusTime(flag.flaggedAt)}, band ${flag.band}. Nothing below is a finding — it is what was recorded, and your job is to decide what it means.`}
      />

      <div className="flex flex-wrap gap-3">
        <Stat label="Band" value={flag.band} />
        <Stat label="Points" value={String(flag.substantivePoints)} />
        <Stat label="Context only" value={String(flag.contextPoints)} />
        <Stat label="Reviewers needed" value={String(Math.max(1, flag.reviewersRequired))} />
        <Stat label="Decide by" value={formatCampusTime(flag.reviewDeadline)} />
      </div>

      {flag.attempt.exemptSignals.length > 0 ? (
        <p className="mt-4 rounded-md border border-info/40 bg-info-subtle px-3 py-2 text-sm text-info">
          This candidate has an approved accommodation, so some signals are discounted and score zero. You are not
          told which accommodation or why — only that it applies.
        </p>
      ) : null}

      <section className="mt-6">
        <h2 className="font-display text-base font-semibold text-text">What was recorded</h2>
        {scored.length === 0 ? (
          <p className="mt-2 text-sm text-text-secondary">Nothing scored. This flag may have been raised by similarity detection.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {scored.map((signal, index) => (
              <li key={index} className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-3">
                <span className="text-sm text-text">{signal.note}</span>
                {signal.exempt ? (
                  <span className="rounded-full border border-info/40 bg-info-subtle px-2 py-0.5 text-xs text-info">
                    Discounted for this candidate
                  </span>
                ) : (
                  <span className="ml-auto text-xs text-text-secondary tabular-nums">
                    {signal.points} {signal.contextOnly ? "(context only)" : ""}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-text-secondary">
          A dropped connection is never a finding. A paste of sample input or of the candidate&apos;s own earlier code
          is normal. Developer tools, a second screen and an automation hint are context only and cannot raise a band
          on their own.
        </p>
      </section>

      <section className="mt-6">
        <h2 className="font-display text-base font-semibold text-text">The sitting</h2>
        <p className="mt-2 text-sm text-text-secondary">
          Started {formatCampusTime(flag.attempt.startedAt)}
          {flag.attempt.submittedAt ? `, submitted ${formatCampusTime(flag.attempt.submittedAt)}` : ", not submitted"} ·{" "}
          {flag.attempt.status.toLowerCase().replace(/_/g, " ")} · focus lost {flag.attempt.focusLosses}× · left full
          screen {flag.attempt.fullscreenExits}× · pasted {flag.attempt.pastes}×
          {flag.attempt.maxHeartbeatGapSeconds >= 45
            ? ` · longest connection gap ${Math.round(flag.attempt.maxHeartbeatGapSeconds / 60)} min`
            : ""}
        </p>
      </section>

      {flag.reviews.length > 0 ? (
        <section className="mt-6">
          <h2 className="font-display text-base font-semibold text-text">Verdicts so far</h2>
          <ul className="mt-2 flex flex-col gap-2">
            {flag.reviews.map((review, index) => (
              <li key={index} className="rounded-lg border border-border bg-surface p-3">
                <p className="text-sm font-medium text-text">
                  {review.verdict === "CLEAR" ? "Cleared" : "Upheld"} by {review.reviewerName} ·{" "}
                  {formatCampusTime(review.decidedAt)}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-text-secondary">{review.rationale}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {flag.appeal ? (
        <section className="mt-6">
          <h2 className="font-display text-base font-semibold text-text">The student&apos;s appeal</h2>
          <p className="mt-1 text-xs text-text-secondary">
            Submitted {formatCampusTime(flag.appeal.submittedAt)} · decide by {formatCampusTime(flag.appeal.decideBy)}.
            Undecided by then resolves in the student&apos;s favour.
          </p>
          <p className="mt-2 whitespace-pre-wrap rounded-lg border border-border bg-surface p-3 text-sm text-text">
            {flag.appeal.reason}
          </p>
          {flag.appeal.outcome === "PENDING" ? (
            <div className="mt-4">
              <VerdictForm
                flagId={flag.flagId}
                appealId={flag.appeal.id}
                reviewersRequired={2}
                reviewsRecorded={(flag.appeal.firstDone ? 1 : 0) + (flag.appeal.secondDone ? 1 : 0)}
              />
            </div>
          ) : (
            <p className="mt-2 text-sm text-text">
              Appeal {flag.appeal.outcome === "OVERTURNED" ? "overturned the flag" : "upheld the flag"}.
            </p>
          )}
        </section>
      ) : null}

      {flag.status === "OPEN" ? (
        <div className="mt-6">
          <VerdictForm
            flagId={flag.flagId}
            reviewersRequired={Math.max(1, flag.reviewersRequired)}
            reviewsRecorded={flag.reviews.length}
          />
        </div>
      ) : (
        <p className="mt-6 rounded-md border border-border px-3 py-2 text-sm text-text-secondary">
          This flag is {flag.status.toLowerCase().replace(/_/g, " ")}. It cannot be reopened.
        </p>
      )}
    </div>
  );
}

function Stat({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <p className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm">
      <span className="text-text-secondary">{label} </span>
      <span className="font-semibold text-text tabular-nums">{value}</span>
    </p>
  );
}
