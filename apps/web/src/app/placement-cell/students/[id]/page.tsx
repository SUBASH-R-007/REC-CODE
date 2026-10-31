import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MISSING_REASON_COPY, TOPIC_LABEL, TOPICS, formatCampusDay } from "@recx/shared";
import { requirePlacementPage } from "@/lib/auth/guards";
import { loadPlacementStudentDrilldown } from "@/server/queries/placement-student";

export const metadata: Metadata = { title: "One student's coverage" };

/**
 * `/placement-cell/students/[id]` — the audited drill-down (Phase 9e).
 *
 * Every view writes one `AuditLog` row, before the read rather than after:
 * a log written afterwards is a log that is missing exactly the reads that
 * failed. The page is `noStore()` through the query, because a cached render
 * is a read that left no record.
 *
 * It shows coverage and the breakdown behind it, and nothing else. No code,
 * no drafts, no notes, no accommodation, no integrity signal — not because
 * those are hard to join, but because an officer explaining a low assessment
 * score is precisely the reviewer SPEC §7 forbids showing a disability label
 * to, and the same reasoning covers the rest.
 *
 * Every score carries the weight that was measurable for THIS student, which
 * is why there is no comparison to a threshold anywhere on the page: the
 * thresholds live on a drive, with a human decision and a recorded reason.
 */
export default async function PlacementStudentPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePlacementPage();
  const { id } = await params;
  const student = await loadPlacementStudentDrilldown(actor.id, id);
  if (!student) notFound();

  return (
    <div className="space-y-7">
      <header className="space-y-2">
        <p className="text-sm">
          <Link href="/placement-cell/at-risk" className="text-primary underline">
            Back to the worklist
          </Link>
        </p>
        <h1 className="font-display text-2xl font-bold tracking-tight">{student.name}</h1>
        <p className="text-sm text-text-secondary">
          {student.collegeId}
          {student.departmentCode ? ` · ${student.departmentCode}` : ""}
          {student.batchYear ? ` · ${student.batchYear}` : ""}
          {student.section ? ` · Section ${student.section}` : ""}
        </p>
        <p className="text-xs text-muted">
          {student.lastActiveOn
            ? `Last active ${formatCampusDay(student.lastActiveOn)} (${student.quietDays} day${student.quietDays === 1 ? "" : "s"} ago).`
            : "No activity has ever been recorded."}{" "}
          {/*
            Said on the page, not only in the log. An officer should know that
            opening this page is recorded — it is what makes the record a
            deterrent rather than a surprise.
          */}
          Opening this page was recorded against your account.
        </p>
      </header>

      {student.mentor ? (
        <p className="rounded-lg border border-border bg-primary-subtle/40 p-3 text-sm">
          Routed to <strong>{student.mentor.name}</strong> since {formatCampusDay(student.mentor.since)}.
        </p>
      ) : null}

      {student.tiers.length === 0 ? (
        <p className="max-w-3xl text-sm text-text-secondary">
          Nothing has been computed for this student yet. Readiness is worked out overnight from what they practise.
        </p>
      ) : (
        <>
          <p className="text-xs text-muted">
            From the run of {formatCampusDay(student.computedOn)}, under weights version {student.rulesVersion}
            {student.cohortKey
              ? `, ranked in ${student.cohortKey} (${student.cohortSize} students)`
              : ""}
            .
          </p>

          <div className="space-y-6">
            {student.tiers.map((tier) => (
              <section key={tier.tier} className="space-y-3">
                <h2 className="flex flex-wrap items-baseline gap-2 font-display text-lg font-semibold">
                  <span>{tier.label}</span>
                  <span className="text-sm font-normal text-text-secondary">
                    {tier.score === null
                      ? "nothing measurable"
                      : `${tier.score} out of ${tier.availableWeight} measurable`}
                  </span>
                </h2>
                <table className="w-full border-collapse text-sm">
                  <caption className="sr-only">
                    {tier.label}: every component, what it contributed and what it can contribute
                  </caption>
                  <thead>
                    <tr className="border-b border-border text-left">
                      <th scope="col" className="py-1.5 pr-3 font-semibold">
                        Component
                      </th>
                      <th scope="col" className="py-1.5 pr-3 font-semibold">
                        Contributed
                      </th>
                      <th scope="col" className="py-1.5 font-semibold">
                        Of a possible
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {tier.components.map((row) => (
                      <tr key={row.component} className="border-b border-border last:border-0">
                        <th scope="row" className="py-1.5 pr-3 text-left font-medium">
                          {row.label}
                          {row.state.state === "MISSING" ? (
                            <span className="block text-xs font-normal text-text-secondary">
                              {MISSING_REASON_COPY[row.state.reason]}
                            </span>
                          ) : null}
                          {row.limitingTopic ? (
                            <span className="block text-xs font-normal text-text-secondary">
                              Lowest topic: {TOPIC_LABEL[row.limitingTopic]} ({row.limitingCount ?? 0} of{" "}
                              {row.perTopicTarget ?? 0})
                            </span>
                          ) : null}
                        </th>
                        <td className="py-1.5 pr-3 tabular-nums">
                          {row.state.state === "PRESENT" ? row.points.toFixed(1) : "—"}
                        </td>
                        <td className="py-1.5 tabular-nums">{Math.round(row.weight * 100)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            ))}
          </div>

          <section className="space-y-3">
            <h2 className="font-display text-lg font-semibold">Breadth, topic by topic</h2>
            <p className="max-w-3xl text-sm text-text-secondary">
              Unassisted solves per topic — the counts the breadth MINIMUM was taken over, so the figure is checkable
              rather than asserted.
            </p>
            <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
              {TOPICS.map((topic) => (
                <li
                  key={topic}
                  className="flex items-baseline justify-between gap-3 border-b border-border py-1.5 text-sm"
                >
                  <span>{TOPIC_LABEL[topic]}</span>
                  <span className="tabular-nums text-text-secondary">{student.topicUnassisted[topic] ?? 0}</span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      <p className="max-w-3xl border-t border-border pt-5 text-xs text-muted">
        This page shows coverage and the breakdown behind it. It does not show the student&rsquo;s code, their drafts,
        their notes, their accommodations or anything about exam proctoring, and there is no route from here to any of
        those. Readiness is a preparation measure, not a prediction, and nobody uses it to decide who may sit a drive.
      </p>
    </div>
  );
}
