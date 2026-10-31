import Link from "next/link";
import { ArrowLeft, CircleCheck, CircleMinus, CirclePause, CircleSlash, GraduationCap, Archive } from "lucide-react";
import type { AccountStatus } from "@recx/db";
import { Badge } from "@recx/design";

/**
 * Small server-rendered building blocks shared by the admin pages: the page
 * header, an accessible horizontally-scrolling table frame and the account
 * status badge (icon + text, never colour alone).
 */

export const TH = "px-3 py-2.5 text-left font-medium first:pl-5 last:pr-5 whitespace-nowrap";
export const TD = "px-3 py-2.5 first:pl-5 last:pr-5 align-top";
export const THEAD_ROW = "border-b border-border text-xs uppercase tracking-wide text-muted";
export const TBODY_ROW = "border-t border-border first:border-t-0";

export function AdminPageHeader({
  title,
  description,
  actions,
  back,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <header className="mb-6 space-y-2">
      {back ? (
        <Link
          href={back.href as never}
          className="inline-flex min-h-8 items-center gap-1.5 text-sm text-text-secondary hover:text-text hover:underline"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          {back.label}
        </Link>
      ) : null}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-bold tracking-tight break-words">{title}</h1>
          {description ? <div className="mt-1 max-w-3xl text-sm text-text-secondary">{description}</div> : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}

/** A table that may be wider than a phone: the frame scrolls and can be focused from the keyboard. */
export function TableFrame({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={label}>
      {children}
    </div>
  );
}

const STATUS: Record<AccountStatus, { label: string; tone: "success" | "warning" | "danger" | "default" | "info"; Icon: typeof CircleCheck }> = {
  ACTIVE: { label: "Active", tone: "success", Icon: CircleCheck },
  SOFT_RESTRICTED: { label: "Soft-restricted", tone: "warning", Icon: CirclePause },
  DISABLED: { label: "Disabled", tone: "danger", Icon: CircleSlash },
  GRADUATED: { label: "Graduated", tone: "info", Icon: GraduationCap },
  ARCHIVED: { label: "Archived", tone: "default", Icon: Archive },
};

export function AccountStatusBadge({ status }: { status: AccountStatus }) {
  const s = STATUS[status] ?? { label: status, tone: "default" as const, Icon: CircleMinus };
  return (
    <Badge tone={s.tone}>
      <s.Icon className="h-3.5 w-3.5" aria-hidden />
      {s.label}
    </Badge>
  );
}

export const IST_DATE = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Asia/Kolkata",
});

export const IST_DATE_TIME = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "Asia/Kolkata",
});

export function formatDate(d: Date | null | undefined): string {
  return d ? IST_DATE.format(d) : "—";
}

export function formatDateTime(d: Date | null | undefined): string {
  return d ? `${IST_DATE_TIME.format(d)} IST` : "—";
}

const IST_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** A <input type="datetime-local"> value for `d` in IST ("2026-10-17T18:00"). */
export function istLocalInput(d: Date): string {
  const parts = IST_PARTS.formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}
