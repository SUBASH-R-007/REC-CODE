import type { Metadata } from "next";
import Link from "next/link";
import { ButtonLink, EmptyState } from "@recx/design";
import { ELIGIBILITY_FRAMING, READINESS_TIER_LABEL, formatCampusDay } from "@recx/shared";
import { requirePlacementPage } from "@/lib/auth/guards";
import { listDrives } from "@/server/queries/placement-drives";

export const metadata: Metadata = { title: "Drives" };

/**
 * `/placement-cell/drives` — the company visits (Phase 9f).
 *
 * The framing is on the list, not only on the decision form, because this is
 * the page somebody reads first. SPEC §5: the platform produces a number and
 * a human makes the decision — and a list that showed counts beside a
 * one-click "mark all eligible" would be the automatic decision the spec
 * forbids, dressed as a convenience. There is no such control anywhere in
 * this tree.
 */
export default async function DrivesPage() {
  await requirePlacementPage();
  const drives = await listDrives();
  const live = drives.filter((drive) => drive.archivedOn === null);
  const archived = drives.filter((drive) => drive.archivedOn !== null);

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="font-display text-2xl font-bold tracking-tight">Drives</h1>
        <p className="max-w-3xl text-sm">{ELIGIBILITY_FRAMING}</p>
      </header>

      <ButtonLink href="/placement-cell/drives/new">Add a drive</ButtonLink>

      {live.length === 0 ? (
        <EmptyState
          title="No drives yet"
          description="Add one, and the readiness count for its cohort and tier appears on its page."
        />
      ) : (
        <ul className="space-y-3">
          {live.map((drive) => (
            <li key={drive.id} className="rounded-xl border border-border p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h2 className="font-display text-base font-semibold">
                  <Link href={`/placement-cell/drives/${drive.id}`} className="text-primary underline">
                    {drive.companyName}
                  </Link>
                </h2>
                <p className="text-sm text-text-secondary">{formatCampusDay(drive.driveOn)}</p>
              </div>
              <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
                <div className="flex gap-2">
                  <dt className="text-text-secondary">Tier</dt>
                  <dd>{READINESS_TIER_LABEL[drive.tier]}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-text-secondary">Bar</dt>
                  {/*
                    "% of measurable" in the words. A bare "70" invites the
                    comparison against a raw score that the design's review
                    caught — with mockInterviewScore unsourced, no TOP score
                    can reach 70 out of 100 at all.
                  */}
                  <dd>
                    {drive.thresholdScore === null
                      ? "none"
                      : `${drive.thresholdScore}% of what was measurable`}
                  </dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-text-secondary">Decisions recorded</dt>
                  <dd className="tabular-nums">{drive.decisionsRecorded}</dd>
                </div>
              </dl>
              {drive.eligibleDepartmentCodes.length > 0 || drive.eligibleBatchYear ? (
                <p className="mt-1 text-sm text-text-secondary">
                  {[
                    drive.eligibleDepartmentCodes.length > 0
                      ? drive.eligibleDepartmentCodes.join(", ")
                      : "all departments",
                    drive.eligibleBatchYear ? `batch ${drive.eligibleBatchYear}` : "all batches",
                  ].join(" · ")}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {archived.length > 0 ? (
        <section className="space-y-2 border-t border-border pt-5">
          <h2 className="font-display text-base font-semibold">Archived</h2>
          {/* Archived, never deleted: the decisions are the record of what the drive was used for. */}
          <ul className="space-y-1 text-sm">
            {archived.map((drive) => (
              <li key={drive.id} className="flex flex-wrap justify-between gap-x-4">
                <Link href={`/placement-cell/drives/${drive.id}`} className="text-primary underline">
                  {drive.companyName}
                </Link>
                <span className="text-text-secondary">
                  {formatCampusDay(drive.driveOn)} · {drive.decisionsRecorded} decision
                  {drive.decisionsRecorded === 1 ? "" : "s"} kept
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
