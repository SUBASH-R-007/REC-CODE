import type { Metadata } from "next";
import { CheckCircle2, XCircle } from "lucide-react";
import { Card, CardBody, CardHeader, EmptyState, StatCard } from "@recx/design";
import { SCHEDULER_JOB_NAMES } from "@recx/shared";
import { requireSuperAdminPage } from "@/lib/auth/guards";
import { PRIVILEGED_KIND_LABEL } from "@/lib/privileged/payloads";
import { loadJobsPage } from "@/server/queries/super-jobs";
import { AutoRefresh } from "@/components/admin/auto-refresh";
import { formatIst, OperationStatusBadge, PageHeader } from "@/components/super/ui";

export const metadata: Metadata = { title: "Jobs · Super-admin" };

const IST_TIME = new Intl.DateTimeFormat("en-IN", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: "Asia/Kolkata",
});

/** Background work: judge queues and backlog, scheduler jobs, the email outbox, running privileged operations. */
export default async function SuperJobsPage() {
  await requireSuperAdminPage();
  const now = new Date();
  const data = await loadJobsPage(now);
  const byJob = new Map(data.jobs.map((j) => [j.job, j]));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Jobs"
        description="Queues, the scheduler and the email outbox. Read-only; this page refreshes itself."
        action={<AutoRefresh updatedLabel={`Updated ${IST_TIME.format(now)} IST`} />}
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Judging with an expired lease" value={data.backlog.expiredLeases} hint="The reconciler requeues these." />
        <StatCard label="Queued for over 2 minutes" value={data.backlog.queuedLong} />
        <StatCard label="Internal errors (24 h)" value={data.backlog.ieToday} hint="Rejudge from /admin/judge." />
      </div>

      <Card>
        <CardHeader title="Judge queues" subtitle="Waiting / active per lane, read from Redis." />
        <CardBody>
          {data.depths === null ? (
            <p className="text-sm text-danger">Redis could not be read. Rows stay QUEUED in Postgres and are not lost.</p>
          ) : (
            <ul className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-5">
              {Object.entries(data.depths).map(([lane, depth]) => (
                <li key={lane} className="rounded-lg border border-border px-3 py-2">
                  <span className="font-medium">{lane}</span>
                  <span className="block text-xs text-text-secondary">
                    {depth ? `${depth.waiting} waiting · ${depth.active} active` : "—"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Scheduler" subtitle="Stale = no finished tick in 3 reconciler intervals." />
        <CardBody>
          <div tabIndex={0} aria-label="Scheduler jobs" className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[44rem] text-left text-sm">
              <caption className="sr-only">Scheduler jobs and their last tick</caption>
              <thead className="bg-primary-subtle/40 text-xs uppercase tracking-wide text-text-secondary">
                <tr>
                  <th scope="col" className="px-3 py-2">Job</th>
                  <th scope="col" className="px-3 py-2">State</th>
                  <th scope="col" className="px-3 py-2">Last tick</th>
                  <th scope="col" className="px-3 py-2">Failures in a row</th>
                  <th scope="col" className="px-3 py-2">Last error</th>
                </tr>
              </thead>
              <tbody>
                {SCHEDULER_JOB_NAMES.map((name) => {
                  const job = byJob.get(name);
                  const healthy = job ? job.lastOk && !job.stale : false;
                  return (
                    <tr key={name} className="border-t border-border align-top">
                      <th scope="row" className="px-3 py-2 font-medium">
                        {name}
                      </th>
                      <td className="px-3 py-2">
                        <span className={`inline-flex items-center gap-1 ${healthy ? "text-success" : "text-danger"}`}>
                          {healthy ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : <XCircle className="h-4 w-4" aria-hidden />}
                          {!job ? "never ran" : job.stale ? "stale" : job.lastOk ? "ok" : "failing"}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs">{job ? formatIst(job.lastFinishedAt ?? job.lastStartedAt) : "—"}</td>
                      <td className="px-3 py-2 tabular-nums">{job?.consecutiveFailures ?? 0}</td>
                      <td className="px-3 py-2 text-xs break-words">{job?.lastError ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Email outbox" subtitle={`Oldest waiting since ${formatIst(data.oldestPendingAt)}`} />
        <CardBody>
          <ul className="grid gap-2 text-sm sm:grid-cols-4">
            {(["PENDING", "SENDING", "SENT", "FAILED"] as const).map((status) => (
              <li key={status} className="rounded-lg border border-border px-3 py-2">
                <span className="font-medium">{status}</span>
                <span className="block tabular-nums">{data.outbox[status] ?? 0}</span>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Privileged operations running or failed" />
        <CardBody>
          {data.operations.length === 0 ? (
            <EmptyState compact title="None" />
          ) : (
            <ul className="space-y-2">
              {data.operations.map((op) => (
                <li key={op.id} className="space-y-1 rounded-xl border border-border p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{PRIVILEGED_KIND_LABEL[op.kind]}</span>
                    <OperationStatusBadge status={op.status} />
                  </div>
                  <p>{op.summary}</p>
                  {op.error ? <p className="break-words text-xs text-danger">{op.error}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
