import { HeartOff, Server } from "lucide-react";
import { Badge, Card, cn } from "@recx/design";
import { LIMITS } from "@recx/shared";
import { formatAge, formatRate, formatSignedRate } from "@/lib/judge/metrics";
import type { AdminNodeRow } from "@/server/queries/admin-judge";
import { NodeActions } from "@/components/admin/node-actions";
import { CheckChip, LaneEligibilityChip, NodeStatusChip } from "@/components/admin/status-chips";

function Item({ term, children, className }: { term: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-xs font-medium uppercase tracking-wide text-muted">{term}</dt>
      <dd className="mt-1 text-sm text-text tabular-nums">{children}</dd>
    </div>
  );
}

function Failures({ items, label }: { items: string[]; label: string }) {
  if (items.length === 0) return null;
  return (
    <details className="mt-1.5">
      <summary className="cursor-pointer text-xs text-text-secondary hover:text-text">
        {items.length} {items.length === 1 ? label : `${label}s`}
      </summary>
      <ul className="mt-1 space-y-0.5 font-mono text-xs break-words text-text-secondary">
        {items.map((f, k) => (
          <li key={k}>{f}</li>
        ))}
      </ul>
    </details>
  );
}

const ago = (ms: number | null) => (ms === null ? "never" : `${formatAge(ms)} ago`);

/** One judge node: identity, health, eligibility and the admin actions. */
export function NodeCard({ node }: { node: AdminNodeRow }) {
  const maxDeviation = formatRate(LIMITS.calibration.maxDeviation, 0);
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start gap-3">
        <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary-subtle text-primary">
          <Server className="h-4.5 w-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="flex flex-wrap items-center gap-2 font-display text-base font-semibold tracking-tight">
            <span className="font-mono">{node.id}</span>
            <NodeStatusChip status={node.status} />
            {node.heartbeatStale && node.status !== "OFFLINE" && (
              <Badge tone="danger">
                <HeartOff className="h-3.5 w-3.5" aria-hidden />
                No heartbeat
              </Badge>
            )}
          </h3>
          <p className="truncate text-sm text-text-secondary">{node.hostname || "hostname not reported"}</p>
        </div>
        <NodeActions
          nodeId={node.id}
          status={node.status}
          selfCheckOk={node.selfCheckOk}
          heartbeatStale={node.heartbeatStale}
        />
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
        <Item term="Driver">
          <span className="font-mono">{node.driver}</span>
        </Item>
        <Item term="Worker / isolate">
          <span className="font-mono">
            {node.workerVersion || "—"} / {node.isolateVersion || "—"}
          </span>
        </Item>
        <Item term="Slots busy">
          {node.busySlots} / {node.slots}
        </Item>
        <Item term="Last heartbeat">
          <span className={node.heartbeatStale ? "font-medium text-danger" : undefined}>{ago(node.heartbeatAgeMs)}</span>
        </Item>
        <Item term="Calibration">
          {node.calibrationScore === null ? (
            <span className="text-muted">Not measured</span>
          ) : (
            <>
              <span className="font-mono">{node.calibrationScore.toFixed(1)}</span>
              <span className="text-text-secondary"> · {ago(node.calibrationAgeMs)}</span>
              <span className={cn("block text-xs", node.calibrationOutlier ? "font-medium text-danger" : "text-muted")}>
                {formatSignedRate(node.calibrationDeviation)} vs fleet median
                {node.calibrationOutlier ? ` (over ${maxDeviation})` : ""}
              </span>
            </>
          )}
        </Item>
        <Item term="Self-check">
          <span className="flex flex-wrap items-center gap-1.5">
            <CheckChip state={node.selfCheckState} />
            {node.selfCheckAgeMs !== null && <span className="text-xs text-text-secondary">{ago(node.selfCheckAgeMs)}</span>}
          </span>
          <Failures items={node.selfCheckFailures} label="failure" />
        </Item>
        <Item term="Host hardening">
          <CheckChip state={node.hardeningState} />
          <Failures items={node.hardeningFailures} label="failure" />
        </Item>
        <Item term="Assessment / contest lanes">
          <LaneEligibilityChip ok={node.sensitiveLanesOk} />
          <Failures items={node.laneRestrictions} label="restriction" />
        </Item>
        <Item term="Consecutive IE">
          <span className={node.consecutiveIe > 0 ? "font-medium text-warning" : undefined}>{node.consecutiveIe}</span>
        </Item>
        <Item term="Languages" className="col-span-2 sm:col-span-3">
          {node.languages.length === 0 ? (
            <span className="text-muted">None reported</span>
          ) : (
            <span className="font-mono text-xs">{node.languages.join(", ")}</span>
          )}
        </Item>
      </dl>
    </Card>
  );
}
