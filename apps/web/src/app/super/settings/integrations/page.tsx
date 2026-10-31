import type { Metadata } from "next";
import { CheckCircle2, XCircle } from "lucide-react";
import { Card, CardBody, CardHeader } from "@recx/design";
import { requireSuperAdminPage } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { redis } from "@/lib/redis";
import { loadMailHealth } from "@/server/queries/super-dashboard";
import { TestEmailButton } from "@/components/super/test-email-button";
import { formatIst, Notice, PageHeader } from "@/components/super/ui";

export const metadata: Metadata = { title: "Integrations · Super-admin" };

async function redisReachable(): Promise<boolean> {
  try {
    const reply = await Promise.race([
      redis().ping(),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("timeout")), 1_000)),
    ]);
    return reply === "PONG";
  } catch {
    return false;
  }
}

function Status({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${ok ? "text-success" : "text-danger"}`}>
      {ok ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : <XCircle className="h-4 w-4" aria-hidden />}
      {label}
    </span>
  );
}

/**
 * A read-only status page: mail transport (as the scheduler last reported
 * it), the test-data store driver and Redis. Credentials are never read
 * into or shown on this page. The one action is a test email to yourself.
 */
export default async function SuperIntegrationsPage() {
  await requireSuperAdminPage();
  const [mail, outbox, lastSent, redisOk] = await Promise.all([
    loadMailHealth(),
    db.schedulerJobStatus.findUnique({ where: { job: "outbox" }, select: { lastStartedAt: true, lastOk: true } }),
    db.emailOutbox.findFirst({ where: { status: "SENT" }, orderBy: { sentAt: "desc" }, select: { sentAt: true } }),
    redisReachable(),
  ]);
  const transport = mail.transport ?? "unknown (the outbox job has not run)";

  return (
    <div className="space-y-6">
      <PageHeader title="Integrations" description="Status only. Configuration lives in the server environment (docs/RUNBOOK.md)." />
      {mail.transport === "disabled" ? (
        <Notice tone="danger" title="No mail transport: security email is not delivered">
          Set MAIL_TRANSPORT=smtp and SMTP_URL for the scheduler. In-app notifications still go out.
        </Notice>
      ) : null}
      <Card>
        <CardHeader title="Email" subtitle="Security email goes through the outbox; the scheduler sends it." />
        <CardBody className="space-y-3 text-sm">
          <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
            <div>
              <dt className="inline font-medium">Transport </dt>
              <dd className="inline">{transport}</dd>
            </div>
            <div>
              <dt className="inline font-medium">Outbox job last ran </dt>
              <dd className="inline">{formatIst(outbox?.lastStartedAt)}</dd>
            </div>
            <div>
              <dt className="inline font-medium">Last email sent </dt>
              <dd className="inline">{formatIst(lastSent?.sentAt)}</dd>
            </div>
            <div>
              <dt className="inline font-medium">Security email waiting </dt>
              <dd className="inline">{mail.pendingSecurity}</dd>
            </div>
            <div>
              <dt className="inline font-medium">Security email failed </dt>
              <dd className="inline">{mail.failedSecurity}</dd>
            </div>
            <div>
              <dt className="inline font-medium">Oldest waiting since </dt>
              <dd className="inline">{formatIst(mail.oldestPendingAt)}</dd>
            </div>
          </dl>
          <TestEmailButton />
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Services" />
        <CardBody>
          <ul className="space-y-2 text-sm">
            <li>
              Redis (queue transport and rate limits):{" "}
              <Status ok={redisOk} label={redisOk ? "reachable" : "unreachable (judging falls back to the reconciler)"} />
            </li>
            <li>
              Test-data store driver: <span className="font-mono">{env().TESTDATA_DRIVER}</span>
            </li>
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}
