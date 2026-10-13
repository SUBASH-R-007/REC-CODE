import type { Metadata } from "next";
import { Activity, AlertTriangle, Gauge, Server } from "lucide-react";
import { Card, CardHeader, EmptyState, StatCard } from "@recx/design";
import { requireAdminScopePage } from "@/lib/auth/scope";
import { formatDurationMs, formatRate, laneTotals } from "@/lib/judge/metrics";
import { loadJudgeHealth } from "@/server/queries/admin-judge";
import { AutoRefresh } from "@/components/admin/auto-refresh";
import { CapsPanel } from "@/components/admin/caps-panel";
import { LanguageMix, VerdictDistribution } from "@/components/admin/judge-mix";
import { LanguageTable } from "@/components/admin/language-table";
import { LaneTable } from "@/components/admin/lane-table";
import { NodeCard } from "@/components/admin/node-card";
import { StuckTable } from "@/components/admin/stuck-table";

export const metadata: Metadata = { title: "Judge health" };

const IST_TIME = new Intl.DateTimeFormat("en-IN", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: "Asia/Kolkata",
});

/**
 * Judge fleet health: nodes, lanes, stuck work, language mix, language
 * configuration and per-student caps. A server component; the actions are
 * leaf client components calling audited server actions, and the page
 * re-renders itself every 10 s (AutoRefresh → router.refresh()).
 */
export default async function JudgeHealthPage() {
  const { user, scope } = await requireAdminScopePage();
  const health = await loadJudgeHealth(scope);
  const now = health.generatedAt;
  const totals = laneTotals(health.lanes);
  // ONLINE in the database but silent: the sweep has not caught up yet.
  const online = health.nodes.filter((n) => n.status === "ONLINE" && !n.heartbeatStale);
  const silent = health.nodes.filter((n) => n.status === "ONLINE" && n.heartbeatStale).length;
  const onlineSlots = online.reduce((s, n) => s + n.slots, 0);
  const busySlots = online.reduce((s, n) => s + n.busySlots, 0);
  const worstP95 = health.lanes.reduce<number | null>(
    (max, l) => (l.latencyKind === "wait" && l.p95Ms !== null ? Math.max(max ?? 0, l.p95Ms) : max),
    null,
  );
  const labels = new Map(
    health.languages.filter((l) => l.isCurrent).map((l) => [l.key, l.label] as const),
  );

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Judge health</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Nodes, queues and judging over the last hour. Every action here is recorded in the audit log.
          </p>
        </div>
        <AutoRefresh updatedLabel={`Updated ${IST_TIME.format(now)} IST`} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Nodes online"
          icon={<Server className="h-4 w-4" aria-hidden />}
          value={
            <span className="tabular-nums">
              {online.length} / {health.nodes.length}
            </span>
          }
          hint={
            <span className="tabular-nums">
              {busySlots} of {onlineSlots} slots busy
              {silent > 0 ? ` · ${silent} not heartbeating` : ""}
            </span>
          }
        />
        <StatCard
          label="Backlog now"
          icon={<Activity className="h-4 w-4" aria-hidden />}
          value={<span className="tabular-nums">{totals.backlog === null ? "—" : totals.backlog.toLocaleString("en-IN")}</span>}
          hint={totals.backlog === null ? "Redis unavailable" : <span className="tabular-nums">{totals.active ?? 0} active</span>}
        />
        <StatCard
          label="Worst p95 wait (1 h)"
          icon={<Gauge className="h-4 w-4" aria-hidden />}
          value={<span className="tabular-nums">{formatDurationMs(worstP95)}</span>}
          hint={<span className="tabular-nums">{totals.finished.toLocaleString("en-IN")} jobs judged</span>}
        />
        <StatCard
          label="Internal errors (1 h)"
          icon={<AlertTriangle className="h-4 w-4" aria-hidden />}
          value={<span className="tabular-nums">{formatRate(totals.ieRate)}</span>}
          hint={<span className="tabular-nums">{totals.internalErrors} of {totals.finished} finished</span>}
        />
      </div>

      <section aria-labelledby="nodes-heading" className="space-y-3">
        <h2 id="nodes-heading" className="font-display text-lg font-semibold tracking-tight">
          Nodes
        </h2>
        {health.nodes.length === 0 ? (
          <Card>
            <EmptyState
              icon={<Server className="h-6 w-6" />}
              title="No judge nodes registered"
              description="A node appears here after it is registered and sends its first heartbeat. See the runbook: Judge node lifecycle."
            />
          </Card>
        ) : (
          <div className="grid gap-4">
            {health.nodes.map((node) => (
              <NodeCard key={node.id} node={node} />
            ))}
          </div>
        )}
      </section>

      <Card className="overflow-hidden">
        <CardHeader title="Lanes" subtitle="Queue depth now; latency, throughput and internal errors over the last hour." />
        <div className="pb-5 pt-3">
          <LaneTable lanes={health.lanes} queueDepthAvailable={health.queueDepthAvailable} validation={health.validation} />
        </div>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader
          title="Waiting too long"
          subtitle="Queued or judging for more than 2 minutes. A rejudge resets the submission onto the rejudge lane."
        />
        <div className="pb-4 pt-3">
          <StuckTable
            rows={health.stuck.stuck}
            total={health.stuck.stuckTotal}
            caption="Submissions queued or judging for more than 2 minutes"
            emptyTitle="Nothing is stuck"
            emptyDescription="No submission has been waiting or judging for more than 2 minutes."
            now={now}
          />
        </div>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader
          title="Internal errors (7 days)"
          subtitle="Infrastructure failures after 3 attempts. They are excluded from scoring until rejudged."
        />
        <div className="pb-4 pt-3">
          <StuckTable
            rows={health.stuck.failed}
            total={health.stuck.failedTotal}
            caption="Submissions that ended in an internal error in the last 7 days"
            emptyTitle="No internal errors"
            emptyDescription="No submission ended in an internal error in the last 7 days."
            now={now}
          />
        </div>
        <p className="border-t border-border px-5 py-3 text-xs text-muted">
          Rejudge here is for one submission at a time. Bulk and problem-wide rejudges need a super admin and a second
          approver, and arrive with assessments.
        </p>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader title="Languages (24 h)" subtitle="Submissions per language and the share accepted among judged ones." />
          <div className="pb-4 pt-3">
            <LanguageMix rows={health.languageMix} labels={labels} />
          </div>
        </Card>
        <Card className="overflow-hidden">
          <CardHeader title="Verdicts (24 h)" subtitle="How the last day's submissions were judged." />
          <div className="pt-4">
            <VerdictDistribution rows={health.verdicts} />
          </div>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <CardHeader
          title="Language configuration"
          subtitle="One row per language and pinned toolchain. New submissions use the current, enabled row."
        />
        <div className="pb-4 pt-3">
          <LanguageTable rows={health.languages} />
        </div>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader
          title="Judge caps"
          subtitle="Per-student limits that keep the judge fair under load. Overrides are audited."
        />
        <div className="pb-5 pt-4">
          <CapsPanel defaults={health.defaultCaps} overrides={health.overrides} canGrant={user.role === "SUPER_ADMIN"} />
        </div>
      </Card>
    </div>
  );
}
