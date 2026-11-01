import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, CardBody, CardHeader, EmptyState, StatCard } from "@recx/design";
import { requireAdminScopePage } from "@/lib/auth/scope";
import { formatCampusDateTime } from "@/lib/help/copy";
import { AUDIT_EVENT_LIMIT, getAttemptAudit } from "@/server/queries/admin-assessment-results";

export const metadata: Metadata = { title: "Sitting audit" };

const TD = "px-3 py-2";

/**
 * Everything recorded about one sitting (Phase 12y.4).
 *
 * The results table gives a candidate's counters; this is the record they
 * summarise. SPEC §5 asks for a decision to be explainable months later,
 * and until this page the only screen that showed any of the stored signals
 * was the integrity flag page — which exists only for sittings that were
 * flagged. A candidate who left full screen nine times and was never
 * flagged left no trace anybody could read.
 *
 * No band, no points, no integrity score: those belong on
 * `/admin/integrity`, where a human reaches a verdict with the reasoning
 * beside it. Beside a mark they would be read as part of the mark. And no
 * pasted text — the product records a paste's size, never its content
 * (`docs/PROCTORING.md` §5), so there is none to show.
 */
export default async function AttemptAuditPage({
  params,
}: {
  params: Promise<{ id: string; attemptId: string }>;
}) {
  const { scope } = await requireAdminScopePage();
  const { id, attemptId } = await params;
  const audit = await getAttemptAudit(scope, attemptId);
  if (!audit || audit.assessmentId !== id) notFound();

  const minutes = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;

  return (
    <div className="max-w-4xl space-y-6">
      <header className="space-y-2">
        <Link
          href={`/admin/assessments/${id}/results`}
          className="text-sm text-primary underline-offset-2 hover:underline"
        >
          ← {audit.assessmentTitle} · results
        </Link>
        <h1 className="font-display text-2xl font-bold tracking-tight">
          {audit.name} <span className="font-mono text-base font-normal text-muted">{audit.collegeId}</span>
        </h1>
        <p className="text-sm text-text-secondary">
          {audit.status.replace(/_/g, " ").toLowerCase()} · started {formatCampusDateTime(audit.startedAt)}
          {audit.submittedAt ? ` · handed in ${formatCampusDateTime(audit.submittedAt)}` : " · not handed in"}
          {audit.hall ? ` · ${audit.hall}${audit.seatLabel ? ` · ${audit.seatLabel}` : ""}` : ""}
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Tab switches" value={audit.watched.focusLosses} hint="The window lost focus." />
        <StatCard label="Left full screen" value={audit.watched.fullscreenExits} />
        <StatCard label="Pastes" value={audit.watched.pastes} hint="Sizes only — never the text." />
        <StatCard
          label="Longest gap"
          value={audit.watched.longestGapSeconds > 0 ? `${audit.watched.longestGapSeconds}s` : "—"}
          hint="Connection, not attention."
        />
      </div>

      <p className="rounded-lg border border-border p-3 text-sm text-text-secondary">
        These are signals, not findings. A dropped connection is never a finding; a paste of sample input or of the
        candidate&apos;s own earlier code is normal; developer tools, a second screen and an automation hint are
        context only. Nothing here penalises anybody by itself — the band, the points and the verdict are on the{" "}
        <Link className="underline" href="/admin/integrity">
          integrity review
        </Link>
        , where a person decides.
      </p>

      <Card>
        <CardHeader title="What fired, and how often" subtitle="The shape of the sitting at a glance." />
        <CardBody>
          {audit.byKind.length === 0 ? (
            <EmptyState
              title="Nothing was recorded"
              description="This sitting produced no proctoring signals at all. On an ADVISORY paper sat in one window, that is the ordinary case."
            />
          ) : (
            <ul className="flex flex-wrap gap-2">
              {audit.byKind.map((row) => (
                <li key={row.kind} className="rounded-lg border border-border px-3 py-1.5 text-sm">
                  {row.label} <span className="font-mono tabular-nums text-muted">×{row.count}</span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {audit.events.length > 0 ? (
        <Card>
          <CardHeader
            title={`The record (${audit.events.length}${audit.truncated ? `+` : ""})`}
            subtitle="In the order they happened, timed from the start of the sitting."
          />
          <CardBody>
            {audit.truncated ? (
              <p className="mb-3 rounded-lg border border-warning/40 bg-warning-subtle p-3 text-sm">
                Showing the first {AUDIT_EVENT_LIMIT}. This sitting stored more than that — said out loud rather than
                silently cut, because a truncated list that looked complete would be the worst kind of evidence.
              </p>
            ) : null}
            <div role="region" tabIndex={0} aria-label="Recorded signals" className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full min-w-[36rem] text-left text-sm">
                <caption className="sr-only">Every proctoring signal recorded during this sitting</caption>
                <thead className="bg-primary-subtle/40 text-xs uppercase tracking-wide text-text-secondary">
                  <tr>
                    <th scope="col" className={TD}>At</th>
                    <th scope="col" className={TD}>Signal</th>
                    <th scope="col" className={TD}>Severity</th>
                    <th scope="col" className={TD}>From</th>
                    <th scope="col" className={TD}>For</th>
                    <th scope="col" className={TD}>Size</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.events.map((event, index) => (
                    <tr key={`${event.kind}-${event.atMs}-${index}`} className="border-t border-border">
                      <td className={`${TD} font-mono tabular-nums text-xs`}>{minutes(event.atMs)}</td>
                      <td className={TD}>{event.label}</td>
                      <td className={TD}>
                        {event.severity === "HIGH" ? (
                          <Badge tone="danger">high</Badge>
                        ) : event.severity === "MEDIUM" ? (
                          <Badge tone="warning">medium</Badge>
                        ) : (
                          <span className="text-xs text-muted">{event.severity.toLowerCase()}</span>
                        )}
                      </td>
                      <td className={`${TD} text-xs text-muted`}>{event.source.toLowerCase()}</td>
                      <td className={`${TD} tabular-nums text-xs`}>
                        {event.durationMs === null ? "—" : `${Math.round(event.durationMs / 1000)}s`}
                      </td>
                      <td className={`${TD} tabular-nums text-xs`}>
                        {event.size === null ? "—" : `${event.size} B`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
