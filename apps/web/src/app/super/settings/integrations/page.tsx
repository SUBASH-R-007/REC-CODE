import type { Metadata } from "next";
import { CheckCircle2, XCircle } from "lucide-react";
import { Card, CardBody, CardHeader } from "@recx/design";
import { sebSettingKey } from "@recx/shared";
import { requireSuperAdminPage } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { redis } from "@/lib/redis";
import { loadMailHealth } from "@/server/queries/super-dashboard";
import { examBrowserVersionFloor } from "@/lib/exam/containment";
import { EXAM_BROWSER_PROTOCOL_VERSION } from "@recx/shared";
import { downloadsSwitchedOn, examBrowserBuilds } from "@/lib/exam/exam-browser-downloads";
import {
  ExamBrowserDownloadsForm,
  type DownloadsStatus,
} from "@/components/super/exam-browser-downloads-form";
import { ExamBrowserFloorForm } from "@/components/super/exam-browser-floor-form";
import { SebKeysForm } from "@/components/admin/assessments/seb-keys-form";
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
  const [mail, outbox, lastSent, redisOk, sebRow, examBrowserFloor, downloadsOn, builds] = await Promise.all([
    loadMailHealth(),
    db.schedulerJobStatus.findUnique({ where: { job: "outbox" }, select: { lastStartedAt: true, lastOk: true } }),
    db.emailOutbox.findFirst({ where: { status: "SENT" }, orderBy: { sentAt: "desc" }, select: { sentAt: true } }),
    redisReachable(),
    db.platformSetting.findUnique({ where: { key: sebSettingKey(null) }, select: { value: true } }),
    // Phase 14f. Read through the same function the containment check
    // uses, so the screen cannot show a floor the check would not apply.
    examBrowserVersionFloor(),
    // Phase 14i. The switch, and what is on the disk behind it: "on" and
    // "working" are different states and the gap between them is where a
    // hall finds out the morning of a paper.
    downloadsSwitchedOn(),
    examBrowserBuilds(),
  ]);

  /**
   * The disk, with the switch ignored (`examBrowserBuilds`), because this
   * screen has to answer a question the public page never asks: would
   * turning the switch ON offer anything at all? Read through
   * `examBrowserDownloads()` it could not, since that reports
   * "switched_off" and stops.
   */
  const downloadStatus: DownloadsStatus = builds.available
    ? { kind: "ready", version: builds.version, builds: builds.offers.length }
    : builds.reason === "no_build"
      ? { kind: "no_build" }
      : { kind: "not_configured" };
  // Booleans, never the keys themselves.
  const sebValue = sebRow?.value as { configKey?: unknown; browserExamKey?: unknown } | null | undefined;
  const collegeSeb = {
    configKey: typeof sebValue?.configKey === "string" && sebValue.configKey !== "",
    browserExamKey: typeof sebValue?.browserExamKey === "string" && sebValue.browserExamKey !== "",
  };
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
      {/**
        * Safe Exam Browser's college-wide pair (Phase 13d).
        *
        * On this page because SEB is a third-party tool this platform
        * integrates with, and in `super-settings.ts` because
        * `PlatformSetting` is the super-admin's table: a hall's own keys
        * belong to whoever runs the hall, and the default every hall
        * falls back to belongs to whoever runs the college.
        *
        * The state is read as BOOLEANS and the keys never leave the
        * server: "set" or "not set" is the only thing a person needs,
        * and a 64-character digest on a page is a copy of it in every
        * proxy log between here and the browser.
        */}
      <Card>
        <CardHeader
          title="Safe Exam Browser"
          subtitle="The keys a kiosk paper is verified against when its hall has none of its own."
        />
        <CardBody className="space-y-3 text-sm">
          <p className="text-text-secondary">
            A paper set to kiosk mode checks <span className="font-mono">sha256(url + key)</span> on every request. A
            hall with its own pair -- set on the assessment, by whoever runs it -- always wins; this is what the rest
            fall back to. With neither, a kiosk paper refuses every candidate, which is the correct failure direction
            and a bad surprise ten minutes before an exam.
          </p>
          <SebKeysForm
            scope={{ kind: "college" }}
            label="College-wide default"
            configKeySet={collegeSeb.configKey}
            browserExamKeySet={collegeSeb.browserExamKey}
          />
        </CardBody>
      </Card>
      <Card>
        <CardHeader
          title="REC Exam Browser"
          subtitle="The other kiosk option, and the one control a deployment has over which builds may sit a paper."
        />
        <CardBody className="space-y-3 text-sm">
          <p className="text-text-secondary">
            A paper set to REC Exam Browser is sat in an application the candidate launches for that one sitting, which
            presents a key minted for it. Unlike Safe Exam Browser there is no shared secret to configure here: the key
            is derived per sitting from the deployment&apos;s own secret, so there is nothing on this page to leak.
            What there is instead is a floor — the lowest build this deployment will accept, which is how a copy found
            to have a flaw stops being usable the day it is known rather than at the next release.
          </p>
          <ExamBrowserDownloadsForm enabled={downloadsOn} status={downloadStatus} />
          <ExamBrowserFloorForm current={examBrowserFloor} />
          <p className="text-xs text-muted">
            Handshake version {EXAM_BROWSER_PROTOCOL_VERSION}. Candidates read what the application does, and what it
            cannot do, at <span className="font-mono">/exam-browser</span>.
          </p>
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
