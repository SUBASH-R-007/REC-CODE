import type { PrivilegedOperationStatus } from "@recx/db";
import { AlertTriangle, Ban, CheckCircle2, Clock, Hourglass, Loader2, XCircle } from "lucide-react";
import { Badge } from "@recx/design";

/** Small server-rendered pieces shared by the /super pages. */

const IST = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Asia/Kolkata",
});

/** "10 Oct 2026, 14:05 IST" */
export function formatIst(date: Date | null | undefined): string {
  return date ? `${IST.format(date)} IST` : "—";
}

export function PageHeader({ title, description, action }: { title: string; description: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="font-display text-2xl font-bold tracking-tight">{title}</h1>
        <div className="mt-1 max-w-3xl text-sm text-text-secondary">{description}</div>
      </div>
      {action ? <div className="min-w-0 max-w-full">{action}</div> : null}
    </div>
  );
}

const STATUS: Record<
  PrivilegedOperationStatus,
  { tone: "default" | "primary" | "success" | "warning" | "danger" | "info"; label: string; Icon: typeof Clock }
> = {
  PENDING: { tone: "warning", label: "Waiting for approval", Icon: Hourglass },
  APPROVED: { tone: "info", label: "Approved", Icon: CheckCircle2 },
  EXECUTING: { tone: "info", label: "Running", Icon: Loader2 },
  EXECUTED: { tone: "success", label: "Done", Icon: CheckCircle2 },
  FAILED: { tone: "danger", label: "Failed", Icon: AlertTriangle },
  REJECTED: { tone: "danger", label: "Rejected", Icon: XCircle },
  CANCELLED: { tone: "default", label: "Cancelled", Icon: Ban },
  EXPIRED: { tone: "default", label: "Expired", Icon: Clock },
};

/** Status with icon and text (never colour alone). */
export function OperationStatusBadge({ status }: { status: PrivilegedOperationStatus }) {
  const { tone, label, Icon } = STATUS[status];
  return (
    <Badge tone={tone}>
      <Icon className="h-3 w-3" aria-hidden />
      {label}
    </Badge>
  );
}

/** A labelled alert block: icon + text, tone by severity. */
export function Notice({
  tone,
  title,
  children,
}: {
  tone: "danger" | "warning" | "info";
  title: string;
  children?: React.ReactNode;
}) {
  const classes = {
    danger: "border-danger/30 bg-danger-subtle text-danger",
    warning: "border-warning/30 bg-warning-subtle text-warning",
    info: "border-info/30 bg-info-subtle text-info",
  }[tone];
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={`flex gap-3 rounded-xl border p-3 text-sm ${classes}`}>
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0">
        <p className="font-semibold">{title}</p>
        {children ? <div className="mt-0.5 text-text-secondary">{children}</div> : null}
      </div>
    </div>
  );
}
