import type { Metadata } from "next";
import Link from "next/link";
import { Badge, ButtonLink, EmptyState } from "@recx/design";
import { requireAdminScopePage } from "@/lib/auth/scope";
import { describeScope } from "@/lib/auth/scope-where";
import { formatCampusDateTime } from "@/lib/help/copy";
import {
  ASSESSMENT_STATUSES,
  listAssessments,
  type AssessmentStatusFilter,
} from "@/server/queries/admin-assessments";

export const metadata: Metadata = { title: "Assessments" };

const TD = "px-3 py-2";

const MODE_SHORT: Record<string, string> = {
  ADVISORY: "Advisory",
  REMOTE_MONITORED: "Remote",
  KIOSK_SEB: "Kiosk (SEB)",
  LAB_SUPERVISED: "Lab",
};

function statusTone(status: string): "default" | "info" | "success" | "warning" {
  if (status === "OPEN") return "success";
  if (status === "PUBLISHED") return "info";
  if (status === "DRAFT") return "warning";
  return "default";
}

/** The filters as a query string, so every link keeps the ones not being changed. */
function href(current: { search: string; status: string; page: number }, change: Partial<typeof current>): string {
  const next = { ...current, ...change };
  const params = new URLSearchParams();
  if (next.search) params.set("q", next.search);
  if (next.status) params.set("status", next.status);
  if (next.page > 1) params.set("page", String(next.page));
  const query = params.toString();
  return query ? `/admin/assessments?${query}` : "/admin/assessments";
}

/**
 * Every assessment, drafts included (Phase 12a).
 *
 * The engine that runs a sitting — the readiness check, the telemetry, the
 * invigilation page, the integrity queue — has existed since Phase 6, and
 * until Phase 12a nothing could create the thing it runs.
 *
 * Searched, filtered and paged since 13j. It used to be the newest two
 * hundred and nothing else: no way to find a paper by name, and a silent
 * cap that would have quietly stopped showing a department's older papers
 * in the third year of use, with nothing on the page admitting it. A
 * college runs hundreds of papers a year and the one somebody wants is
 * almost always one they can name.
 *
 * The form is a plain GET with no client island: the filters belong in the
 * URL, where they can be linked, bookmarked and reloaded, and a list that
 * needs JavaScript to be filtered is a list that cannot be sent to a
 * colleague.
 */
export default async function AdminAssessmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; page?: string }>;
}) {
  const { scope } = await requireAdminScopePage();
  const params = await searchParams;
  const search = (params.q ?? "").trim();
  const status = (ASSESSMENT_STATUSES as readonly string[]).includes(params.status ?? "")
    ? (params.status as AssessmentStatusFilter)
    : null;
  const requested = Number.parseInt(params.page ?? "1", 10);
  const result = await listAssessments(scope, {
    search,
    status,
    page: Number.isFinite(requested) ? requested : 1,
  });
  const current = { search, status: status ?? "", page: result.page };
  const filtered = search !== "" || status !== null;

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold text-text">Assessments</h1>
          <p className="mt-1 text-sm text-text-secondary">
            A test a cohort sits, under a proctor mode chosen when it is created. Every assessment is proctored; a
            contest or a practice problem is the place for a sitting nobody watches.
          </p>
          {/* Phase 13j: the Sittings column counts this reader's own
              students, like the results page it links to. */}
          <p className="mt-1 text-sm text-muted">{describeScope(scope)}</p>
        </div>
        <ButtonLink href="/admin/assessments/new">New assessment</ButtonLink>
      </div>

      <form method="GET" action="/admin/assessments" className="mb-4 flex flex-wrap items-end gap-3">
        <div className="min-w-[14rem] flex-1">
          <label htmlFor="assessment-search" className="block text-xs font-medium uppercase tracking-wide text-text-secondary">
            Search
          </label>
          <input
            id="assessment-search"
            type="search"
            name="q"
            defaultValue={search}
            placeholder="Title or address"
            className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
        </div>
        <div>
          <label htmlFor="assessment-status" className="block text-xs font-medium uppercase tracking-wide text-text-secondary">
            Status
          </label>
          <select
            id="assessment-status"
            name="status"
            defaultValue={status ?? ""}
            className="mt-1 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <option value="">Any status</option>
            {ASSESSMENT_STATUSES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          className="rounded-lg border border-border-strong bg-surface px-3 py-1.5 text-sm font-medium text-text hover:bg-primary-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          Filter
        </button>
        {filtered ? (
          <Link href="/admin/assessments" className="text-sm text-primary underline-offset-2 hover:underline">
            Clear
          </Link>
        ) : null}
      </form>

      {result.total === 0 ? (
        <EmptyState
          title={filtered ? "No assessment matches" : "No assessments yet"}
          description={
            filtered
              ? "Nothing matches that search and status. Clear the filters to see every paper."
              : "Create one, add its questions at their frozen revisions, schedule a hall if it is lab-supervised, then publish it."
          }
        />
      ) : (
        <>
          <p className="mb-2 text-sm text-text-secondary tabular-nums">
            {result.total} {result.total === 1 ? "assessment" : "assessments"}
            {result.pageCount > 1 ? ` · page ${result.page} of ${result.pageCount}` : ""}
          </p>
          <div className="overflow-x-auto rounded-2xl border border-border">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Every assessment, newest first</caption>
              <thead className="border-b border-border bg-elevated text-xs uppercase tracking-wide text-text-secondary">
                <tr>
                  <th scope="col" className={TD}>Assessment</th>
                  <th scope="col" className={TD}>Status</th>
                  <th scope="col" className={TD}>Watched</th>
                  <th scope="col" className={TD}>Opens</th>
                  <th scope="col" className={TD}>Closes</th>
                  <th scope="col" className={TD}>Questions</th>
                  <th scope="col" className={TD}>Halls</th>
                  <th scope="col" className={TD}>Sittings</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((a) => (
                  <tr key={a.id} className="border-b border-border last:border-0">
                    <th scope="row" className={`${TD} font-normal`}>
                      <Link href={`/admin/assessments/${a.id}`} className="font-medium text-primary hover:underline">
                        {a.title}
                      </Link>
                      <div className="text-xs text-muted">{a.slug}</div>
                    </th>
                    <td className={TD}>
                      <Badge tone={statusTone(a.status)}>{a.status}</Badge>
                      {/* Phase 13j: marking and releasing are two acts, and
                          which one a paper has reached is a thing staff
                          chase one row at a time otherwise. */}
                      {a.resultsPublishedAt ? (
                        <div className="mt-1 text-xs text-muted">results released</div>
                      ) : null}
                    </td>
                    <td className={TD}>
                      {MODE_SHORT[a.proctorMode] ?? a.proctorMode}
                      {a.affectsPlacementEligibility ? (
                        <div className="text-xs text-muted">counts for placement</div>
                      ) : null}
                    </td>
                    <td className={TD}>{formatCampusDateTime(a.opensAt)}</td>
                    <td className={TD}>{formatCampusDateTime(a.closesAt)}</td>
                    <td className={`${TD} tabular-nums`}>{a.questions}</td>
                    <td className={`${TD} tabular-nums`}>{a.halls}</td>
                    <td className={`${TD} tabular-nums`}>
                      {a.attempts > 0 ? (
                        <Link
                          href={`/admin/assessments/${a.id}/results`}
                          className="text-primary underline-offset-2 hover:underline"
                        >
                          {a.attempts}
                        </Link>
                      ) : (
                        a.attempts
                      )}
                      {/* The number an invigilator opens this page for. */}
                      {a.sitting > 0 ? (
                        <div className="text-xs font-medium text-success">{a.sitting} sitting now</div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {result.pageCount > 1 ? (
            <nav className="mt-4 flex items-center justify-between gap-3" aria-label="Pages">
              {result.page > 1 ? (
                <Link
                  href={href(current, { page: result.page - 1 })}
                  className="rounded-lg border border-border px-3 py-1.5 text-sm text-text hover:bg-primary-subtle"
                >
                  ← Newer
                </Link>
              ) : (
                <span />
              )}
              <span className="text-sm text-text-secondary tabular-nums">
                Page {result.page} of {result.pageCount}
              </span>
              {result.page < result.pageCount ? (
                <Link
                  href={href(current, { page: result.page + 1 })}
                  className="rounded-lg border border-border px-3 py-1.5 text-sm text-text hover:bg-primary-subtle"
                >
                  Older →
                </Link>
              ) : (
                <span />
              )}
            </nav>
          ) : null}
        </>
      )}
    </div>
  );
}
