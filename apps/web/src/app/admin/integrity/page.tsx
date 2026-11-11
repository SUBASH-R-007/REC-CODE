import type { Metadata } from "next";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { EmptyState, StatCard } from "@recx/design";
import { formatCampusTime } from "@recx/shared";
import { requireAdminScopePage } from "@/lib/auth/scope";
import { QUEUE_PAGE_LIMIT, listReviewQueue } from "@/server/queries/admin-integrity";
import type { TriageBand } from "@recx/shared";
import { AdminPageHeader } from "@/components/admin/admin-ui";

export const metadata: Metadata = { title: "Integrity review" };
export const dynamic = "force-dynamic";

/**
 * `/admin/integrity` — the review queue (Phase 6e).
 *
 * Worst first, which is what the severity points are FOR: SPEC §5 calls them
 * "severity points, used only to order the review queue". A LOW-band flag
 * appears only when it is in the mandatory 10% sample, because the rest are
 * bulk-cleared and a queue listing every LOW flag is a queue nobody finishes.
 *
 * The deadline column is the point of the screen. Every row that passes 72
 * hours publishes itself as CLEARED, and that is by design — SPEC §5 puts
 * "the cost of slow review on the institution, not on the student's placement
 * timeline". An overdue row is a staffing problem, not a student's problem.
 */
const BANDS = ["HIGH", "MEDIUM", "LOW"] as const;

/** A filter link that keeps the other filter. */
function filterHref(band: string | null, overdue: boolean): string {
  const params = new URLSearchParams();
  if (band) params.set("band", band);
  if (overdue) params.set("overdue", "1");
  const query = params.toString();
  return query ? `/admin/integrity?${query}` : "/admin/integrity";
}

export default async function IntegrityQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ band?: string; overdue?: string }>;
}) {
  await requireAdminScopePage();
  const params = await searchParams;
  const band = (BANDS as readonly string[]).includes(params.band ?? "")
    ? (params.band as TriageBand)
    : null;
  const overdueOnly = params.overdue === "1";
  const { rows, counts, truncated, filtered } = await listReviewQueue({ band, overdueOnly });

  return (
    <div>
      <AdminPageHeader
        title="Integrity review"
        description="Sittings withheld from the public leaderboard pending a human decision. Nothing here is a finding: a flag means something unusual was recorded and somebody has to read it. Anything unreviewed after 72 hours publishes itself as cleared."
      />

      {/**
        * The counts first (Phase 13m). "How many are late" is the
        * question a head of department is asked, and until now the only
        * way to answer it was to count rows on a screen. They are over
        * the whole queue, never the filtered slice: the point of "4
        * overdue" is that it stays true while you read the HIGH ones.
        */}
      {counts.open > 0 ? (
        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Waiting" value={counts.open} hint="Open flags that are real queue work." />
          <StatCard
            label="Past the deadline"
            value={counts.overdue}
            hint="Each publishes itself as cleared. A staffing problem, not a student's."
          />
          <StatCard label="High band" value={counts.high} hint="Two independent reviewers each." />
          <StatCard label="Medium" value={counts.medium} />
        </div>
      ) : null}

      {counts.open > 0 ? (
        <nav className="mt-4 flex flex-wrap items-center gap-2 text-sm" aria-label="Filter the queue">
          <span className="text-text-secondary">Show</span>
          {[
            { label: "Everything", band: null as string | null, overdue: false },
            { label: "Overdue only", band: null as string | null, overdue: true },
            ...BANDS.map((b) => ({ label: b, band: b as string | null, overdue: false })),
          ].map((option) => {
            const active = (option.band ?? null) === band && option.overdue === overdueOnly;
            return (
              <Link
                key={`${option.label}`}
                href={filterHref(option.band, option.overdue)}
                aria-current={active ? "true" : undefined}
                className={`rounded-full border px-3 py-1 ${
                  active
                    ? "border-primary bg-primary-subtle font-medium text-primary"
                    : "border-border text-text-secondary hover:bg-primary-subtle"
                }`}
              >
                {option.label}
              </Link>
            );
          })}
        </nav>
      ) : null}

      {rows.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon={<ShieldCheck className="h-6 w-6" aria-hidden />}
            title={filtered ? "Nothing matches that filter" : "Nothing waiting"}
            description={
              filtered
                ? "The queue is not empty — nothing in it matches what you asked for. Show everything to see the rest."
                : "No sitting is currently withheld. Low-band flags are bulk-cleared with a random sample, and those appear here when sampled."
            }
          />
        </div>
      ) : (
        <ul className="mt-6 flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.flagId} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-border bg-surface p-4">
              <span
                className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${
                  row.band === "HIGH"
                    ? "border-danger/40 bg-danger-subtle text-danger"
                    : row.band === "MEDIUM"
                      ? "border-warning/40 bg-warning-subtle text-warning"
                      : "border-border text-text-secondary"
                }`}
              >
                {row.band}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-text">{row.studentName}</p>
                <p className="mt-0.5 text-xs text-text-secondary">
                  {row.collegeId} · {row.assessmentTitle}
                </p>
              </div>
              {row.inSample ? (
                <span className="rounded-full border border-info/40 bg-info-subtle px-2 py-0.5 text-xs text-info">
                  Random sample
                </span>
              ) : null}
              <span className="text-xs text-text-secondary tabular-nums">
                {row.reviewsRecorded} of {Math.max(1, row.reviewersRequired)} reviewed
              </span>
              <span className={`text-xs tabular-nums ${row.overdue ? "text-danger" : "text-text-secondary"}`}>
                {row.overdue ? "Past the 72-hour deadline" : `Decide by ${formatCampusTime(row.reviewDeadline)}`}
              </span>
              <Link
                href={`/admin/integrity/${row.flagId}`}
                className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                Review
              </Link>
            </li>
          ))}
        </ul>
      )}

      {truncated ? (
        <p className="mt-4 text-xs text-muted">
          The first {QUEUE_PAGE_LIMIT} are shown, worst first. Filter by band or to the overdue ones to work through
          the rest.
        </p>
      ) : null}
    </div>
  );
}
