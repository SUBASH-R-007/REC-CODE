import type { JudgeNodeStatus } from "@recx/shared";
import {
  CheckCircle2,
  CircleHelp,
  CirclePause,
  Clock,
  PowerOff,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@recx/design";
import type { CheckState } from "@/lib/judge/metrics";

type Tone = "default" | "success" | "warning" | "danger" | "info";

/** Status text + a distinct icon per state: colour is never the only cue. */
const NODE_STATUS: Record<JudgeNodeStatus, { label: string; icon: LucideIcon; tone: Tone }> = {
  ONLINE: { label: "Online", icon: CheckCircle2, tone: "success" },
  DRAINING: { label: "Draining", icon: CirclePause, tone: "warning" },
  OFFLINE: { label: "Offline", icon: PowerOff, tone: "default" },
  QUARANTINED: { label: "Quarantined", icon: ShieldAlert, tone: "danger" },
};

export function NodeStatusChip({ status }: { status: JudgeNodeStatus }) {
  const s = NODE_STATUS[status];
  const Icon = s.icon;
  return (
    <Badge tone={s.tone}>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {s.label}
    </Badge>
  );
}

const CHECK: Record<CheckState, { label: string; icon: LucideIcon; tone: Tone }> = {
  ok: { label: "Passed", icon: CheckCircle2, tone: "success" },
  failed: { label: "Failed", icon: XCircle, tone: "danger" },
  stale: { label: "Stale", icon: Clock, tone: "warning" },
  unknown: { label: "Not reported", icon: CircleHelp, tone: "default" },
};

/** A self-check / hardening result chip. */
export function CheckChip({ state }: { state: CheckState }) {
  const c = CHECK[state];
  const Icon = c.icon;
  return (
    <Badge tone={c.tone}>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {c.label}
    </Badge>
  );
}

/** Sensitive-lane (ASSESSMENT / CONTEST) eligibility. */
export function LaneEligibilityChip({ ok }: { ok: boolean }) {
  return ok ? (
    <Badge tone="success">
      <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
      Eligible
    </Badge>
  ) : (
    <Badge tone="warning">
      <ShieldX className="h-3.5 w-3.5" aria-hidden />
      Withheld
    </Badge>
  );
}

/** Enabled / disabled with an icon, for language rows. */
export function EnabledChip({ enabled }: { enabled: boolean }) {
  return enabled ? (
    <Badge tone="success">
      <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
      Enabled
    </Badge>
  ) : (
    <Badge tone="default">
      <PowerOff className="h-3.5 w-3.5" aria-hidden />
      Disabled
    </Badge>
  );
}
