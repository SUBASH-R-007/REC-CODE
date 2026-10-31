import type { Metadata } from "next";
import Link from "next/link";
import { Activity, CheckCircle2, Eye, Inbox, Link2, ShieldAlert, XCircle } from "lucide-react";
import { Badge, Card, CardBody, CardHeader, EmptyState, StatCard } from "@recx/design";
import { requireSuperAdminPage } from "@/lib/auth/guards";
import { ROLE_LABEL } from "@/lib/accounts/status";
import { PRIVILEGED_KIND_LABEL } from "@/lib/privileged/payloads";
import { loadSuperDashboard, type OperationView } from "@/server/queries/super-dashboard";
import { OperationActions } from "@/components/super/operation-card";
import { formatIst, Notice, OperationStatusBadge, PageHeader } from "@/components/super/ui";

export const metadata: Metadata = { title: "Super-admin" };

function OperationItem({
  op,
  mine,
  breakGlassEnabled,
}: {
  op: OperationView;
  mine: boolean;
  breakGlassEnabled: boolean;
}) {
  return (
    <li className="space-y-2 rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{PRIVILEGED_KIND_LABEL[op.kind]}</span>
        <OperationStatusBadge status={op.status} />
        {op.breakGlass ? (
          <Badge tone="danger">
            <ShieldAlert className="h-3 w-3" aria-hidden />
            Break-glass
          </Badge>
        ) : null}
      </div>
      <p className="text-sm">{op.summary}</p>
      {op.targets ? (
        <div className="space-y-1 rounded-lg border border-border bg-background p-3 text-xs">
          <p>
            <span className="font-medium">Accounts in this request: </span>
            {op.targets.byRole
              .map(({ role, count }) => `${count.toLocaleString("en-IN")} ${ROLE_LABEL[role as keyof typeof ROLE_LABEL] ?? role}`)
              .join(", ") || "none"}
            {op.targets.missing > 0 ? `; ${op.targets.missing} no longer exist` : ""}
          </p>
          {op.targets.staff.length > 0 ? (
            <p className="font-medium text-danger">
              Includes staff accounts: <span className="break-words font-normal text-text">{op.targets.staff.join(", ")}</span>
            </p>
          ) : (
            <p className="text-text-secondary">No staff or super-admin account is included.</p>
          )}
        </div>
      ) : null}
      <dl className="grid gap-x-4 gap-y-1 text-xs text-text-secondary sm:grid-cols-2">
        <div>
          <dt className="inline font-medium">Requested by </dt>
          <dd className="inline">{op.requestedBy}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Affects </dt>
          <dd className="inline">{op.affectedCount.toLocaleString("en-IN")}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Requested </dt>
          <dd className="inline">{formatIst(op.requestedAt)}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Expires </dt>
          <dd className="inline">{formatIst(op.expiresAt)}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="inline font-medium">Reason </dt>
          <dd className="inline break-words">{op.reason}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="inline font-medium">Request digest </dt>
          <dd className="inline break-all font-mono">{op.payloadSha256}</dd>
        </div>
      </dl>
      {op.status === "PENDING" ? (
        <OperationActions
          id={op.id}
          label={PRIVILEGED_KIND_LABEL[op.kind]}
          summary={op.summary}
          payloadSha256={op.payloadSha256}
          mine={mine}
          breakGlassEnabled={breakGlassEnabled}
        />
      ) : null}
    </li>
  );
}

/**
 * The super-admin overview: privileged requests waiting for me and mine,
 * alerts (legal hold, undelivered security email, live impersonations),
 * today's audit chain head and scheduler health.
 */
export default async function SuperOverviewPage() {
  const user = await requireSuperAdminPage();
  const now = new Date();
  const data = await loadSuperDashboard(user.id, now);
  const unhealthyJobs = data.jobs.filter((j) => j.stale || j.lastOk === false);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Super-admin"
        description="Two-person approvals, platform health and the controls only a super-admin holds. Every action here is recorded in the audit log."
      />

      <div className="space-y-2">
        {data.retention.legalHold ? (
          <Notice tone="warning" title="Legal hold is in force">
            Every retention purge is suspended. <Link className="underline" href="/super/settings/policy">Policy settings</Link>
          </Notice>
        ) : null}
        {!data.retention.valid ? (
          <Notice tone="danger" title="The retention setting is unreadable">
            Purges are held until it is fixed. <Link className="underline" href="/super/settings/policy">Policy settings</Link>
          </Notice>
        ) : null}
        {data.mail.pendingSecurity > 0 && (data.mail.transport === null || data.mail.transport === "disabled") ? (
          <Notice tone="danger" title={`${data.mail.pendingSecurity} security email(s) undelivered: no mail transport`}>
            Configure MAIL_TRANSPORT=smtp for the scheduler (docs/RUNBOOK.md). In-app notifications were sent.
          </Notice>
        ) : null}
        {data.mail.failedSecurity > 0 ? (
          <Notice tone="danger" title={`${data.mail.failedSecurity} security email(s) failed after every retry`}>
            See <Link className="underline" href="/super/settings/integrations">Integrations</Link> and the audit log
            (email.delivery_failed).
          </Notice>
        ) : null}
        {unhealthyJobs.length > 0 ? (
          <Notice tone="warning" title="Scheduler attention needed">
            {unhealthyJobs.map((j) => j.job).join(", ")}: stale or failing. <Link className="underline" href="/super/jobs">Jobs</Link>
          </Notice>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Waiting for you" value={data.awaiting.length} icon={<Inbox className="h-4 w-4" aria-hidden />} />
        <StatCard label="Your open requests" value={data.mine.length} icon={<Activity className="h-4 w-4" aria-hidden />} />
        <StatCard
          label="Live impersonations"
          value={data.liveImpersonations}
          icon={<Eye className="h-4 w-4" aria-hidden />}
        />
        <StatCard
          label={`Audit rows today (${data.chain.day})`}
          value={data.chain.rows.toLocaleString("en-IN")}
          icon={<Link2 className="h-4 w-4" aria-hidden />}
          hint={<span className="break-all font-mono">head {data.chain.hash.slice(0, 16)}…</span>}
        />
      </div>

      <Card>
        <CardHeader
          title="Waiting for your approval"
          subtitle="Requests by another super-admin. Approving runs the operation at once."
        />
        <CardBody>
          {data.awaiting.length === 0 ? (
            <EmptyState compact title="Nothing to decide" description="No other super-admin is waiting for you." />
          ) : (
            <ul className="space-y-3">
              {data.awaiting.map((op) => (
                <OperationItem key={op.id} op={op} mine={false} breakGlassEnabled={data.flags.breakGlassSelfApproval} />
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Your requests"
          subtitle="A second super-admin must approve within 24 hours. Break-glass is for emergencies only."
        />
        <CardBody>
          {data.mine.length === 0 ? (
            <EmptyState compact title="No open requests" />
          ) : (
            <ul className="space-y-3">
              {data.mine.map((op) => (
                <OperationItem key={op.id} op={op} mine breakGlassEnabled={data.flags.breakGlassSelfApproval} />
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Recent decisions" subtitle="The last 15 privileged operations that left the queue." />
        <CardBody>
          {data.recent.length === 0 ? (
            <EmptyState compact title="No decided operations yet" />
          ) : (
            <ul className="space-y-3">
              {data.recent.map((op) => (
                <OperationItem key={op.id} op={op} mine={op.requestedById === user.id} breakGlassEnabled={false} />
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Scheduler" subtitle="Last tick of each job. Details on the Jobs page." />
        <CardBody>
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {data.jobs.map((job) => (
              <li key={job.job} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
                {job.lastOk && !job.stale ? (
                  <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />
                ) : (
                  <XCircle className="h-4 w-4 text-danger" aria-hidden />
                )}
                <span className="font-medium">{job.job}</span>
                <span className="ml-auto text-xs text-text-secondary">
                  {job.lastOk === null ? "never ran" : job.stale ? "stale" : job.lastOk ? "ok" : "failing"}
                </span>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}
