import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ELIGIBILITY_FRAMING, READINESS_TIER_LABEL, formatCampusDay } from "@recx/shared";
import { requirePlacementPage } from "@/lib/auth/guards";
import { driveDetail } from "@/server/queries/placement-drives";
import { EligibilityForm } from "@/components/placement/eligibility-form";

export const metadata: Metadata = { title: "A drive" };

/**
 * `/placement-cell/drives/[id]` — one drive (Phase 9f).
 *
 * The count, the framing, the decisions already recorded, and the form that
 * records one more. In that order, deliberately: the number comes first
 * because it is what the officer came for, the framing comes immediately
 * after because that is the only place it will be read, and the form comes
 * last so nobody is clicking before they have read either.
 *
 * The count's sentence carries its own denominator — "N of M students at TOP
 * ≥ 70% of what was measurable for them" — and the students with nothing
 * measurable are reported separately rather than folded into the shortfall.
 * They are not below the bar; they were never assessed, and letting an
 * officer read those as the same thing is how a cohort gets written off.
 */
export default async function DrivePage({ params }: { params: Promise<{ id: string }> }) {
  await requirePlacementPage();
  const { id } = await params;
  const detail = await driveDetail(id);
  if (!detail) notFound();

  const { drive, count, countSentence } = detail;

  return (
    <div className="space-y-7">
      <header className="space-y-2">
        <p className="text-sm">
          <Link href="/placement-cell/drives" className="text-primary underline">
            Back to drives
          </Link>
        </p>
        <h1 className="font-display text-2xl font-bold tracking-tight">{drive.companyName}</h1>
        <p className="text-sm text-text-secondary">
          {READINESS_TIER_LABEL[drive.tier]} · {formatCampusDay(drive.driveOn)}
          {drive.archivedOn ? ` · archived ${formatCampusDay(drive.archivedOn)}` : ""}
        </p>
        {drive.notes ? <p className="max-w-3xl text-sm">{drive.notes}</p> : null}
      </header>

      <section className="space-y-3 rounded-xl border border-border p-5">
        <h2 className="font-display text-lg font-semibold">How the cohort stands against the bar</h2>
        <p className="font-display text-xl font-semibold tabular-nums">{count.clearing}</p>
        <p className="max-w-3xl text-sm">{countSentence}</p>
        <p className="max-w-3xl text-sm text-text-secondary">
          {drive.eligibleDepartmentCodes.length > 0 || drive.eligibleBatchYear
            ? `Over ${[
                drive.eligibleDepartmentCodes.length > 0
                  ? drive.eligibleDepartmentCodes.join(", ")
                  : "all departments",
                drive.eligibleBatchYear ? `batch ${drive.eligibleBatchYear}` : "all batches",
              ].join(", ")}`
            : "Over the whole college"}
          {detail.computedOn ? `, from the run of ${formatCampusDay(detail.computedOn)}.` : "."}
        </p>
        <p className="max-w-3xl border-t border-border pt-3 text-sm">{ELIGIBILITY_FRAMING}</p>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-lg font-semibold">
          Decisions recorded ({drive.decisionsRecorded})
        </h2>
        {detail.decisions.length === 0 ? (
          <p className="max-w-3xl text-sm text-text-secondary">
            None yet. Each decision is recorded with the person who made it and the reason they gave.
          </p>
        ) : (
          <table className="w-full border-collapse text-sm">
            <caption className="pb-2 text-left text-xs text-text-secondary">
              Every eligibility decision for this drive, newest first, with who decided and why.
            </caption>
            <thead>
              <tr className="border-b border-border text-left">
                <th scope="col" className="py-1.5 pr-3 font-semibold">
                  Student
                </th>
                <th scope="col" className="py-1.5 pr-3 font-semibold">
                  Decision
                </th>
                <th scope="col" className="py-1.5 pr-3 font-semibold">
                  Why
                </th>
                <th scope="col" className="py-1.5 font-semibold">
                  By, and when
                </th>
              </tr>
            </thead>
            <tbody>
              {detail.decisions.map((decision) => (
                <tr key={decision.id} className="border-b border-border last:border-0 align-top">
                  <th scope="row" className="py-2 pr-3 text-left font-medium">
                    <Link href={`/placement-cell/students/${decision.userId}`} className="text-primary underline">
                      {decision.name}
                    </Link>
                    <span className="block text-xs font-normal text-text-secondary">
                      {decision.collegeId}
                      {decision.section ? ` · ${decision.section}` : ""}
                    </span>
                  </th>
                  <td className="py-2 pr-3">{decision.decisionLabel}</td>
                  <td className="py-2 pr-3">{decision.reason}</td>
                  <td className="py-2 text-text-secondary">
                    {decision.decidedBy}
                    <span className="block text-xs">
                      {formatCampusDay(decision.decidedOn)}
                      {decision.readinessOn
                        ? `, against readiness of ${formatCampusDay(decision.readinessOn)}`
                        : ""}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {drive.archivedOn ? (
        <p className="max-w-3xl rounded-lg border border-border p-3 text-sm text-text-secondary">
          This drive is archived, so no further decisions can be recorded against it. The ones above are kept.
        </p>
      ) : (
        <section className="space-y-3 border-t border-border pt-5">
          <h2 className="font-display text-lg font-semibold">Record a decision</h2>
          <EligibilityForm driveId={drive.id} />
        </section>
      )}
    </div>
  );
}
