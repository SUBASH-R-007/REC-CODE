import type { Metadata } from "next";
import Link from "next/link";
import { Search } from "lucide-react";
import type { AuditSensitivity } from "@recx/db";
import { Badge, Card, CardBody, CardHeader, EmptyState, Field, Input, Select } from "@recx/design";
import { chainDayOf } from "@/lib/audit-chain";
import { requireSuperAdminPage } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { listAuditRows, terminalHashOf } from "@/server/queries/super-audit";
import { namesOf } from "@/server/queries/super-dashboard";
import { AuditVerifyButton } from "@/components/super/audit-verify-button";
import { formatIst, Notice, PageHeader } from "@/components/super/ui";

export const metadata: Metadata = { title: "Audit log · Super-admin" };

type Params = Record<string, string | string[] | undefined>;
const SENSITIVITIES = ["NORMAL", "SENSITIVE", "SECURITY"] as const;

function one(value: string | string[] | undefined): string {
  const v = Array.isArray(value) ? value[0] : value;
  return (v ?? "").trim().slice(0, 120);
}

/**
 * The full audit log (capability "audit.readFull"). Filters use indexed
 * shapes only: a day ([chainDay, id]), a sensitivity, or a target account;
 * actor and action filters apply within a day. Newest first, 50 per page.
 */
export default async function SuperAuditPage({ searchParams }: { searchParams: Promise<Params> }) {
  await requireSuperAdminPage();
  const params = await searchParams;
  const dayParam = one(params.day);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(dayParam) ? dayParam : "";
  const sensitivityParam = one(params.sensitivity);
  const sensitivity = (SENSITIVITIES as readonly string[]).includes(sensitivityParam)
    ? (sensitivityParam as AuditSensitivity)
    : undefined;
  const targetRoll = one(params.target);
  const actorRoll = one(params.actor);
  const action = one(params.action);
  const beforeParam = one(params.before);
  const before = /^\d{1,19}$/.test(beforeParam) ? BigInt(beforeParam) : undefined;

  const lookup = async (roll: string) =>
    roll
      ? db.user.findFirst({ where: { collegeId: { equals: roll, mode: "insensitive" } }, select: { id: true } })
      : null;
  const [target, actor] = await Promise.all([lookup(targetRoll), lookup(actorRoll)]);
  const unknownAccount = (targetRoll && !target) || (actorRoll && !actor);

  const { rows, nextBefore } = unknownAccount
    ? { rows: [], nextBefore: null }
    : await listAuditRows(db, {
        day: day || undefined,
        sensitivity,
        targetUserId: target?.id,
        actorId: day ? actor?.id : undefined,
        action: day && action ? action : undefined,
        before,
      });
  const names = await namesOf(rows.flatMap((r) => [r.actorId ?? "", r.targetUserId ?? ""]));
  const shownDay = day || chainDayOf(new Date());
  const head = await terminalHashOf(db, shownDay);
  const next = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (typeof v === "string" && k !== "before") next.set(k, v);
  if (nextBefore) next.set("before", nextBefore);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit log"
        description="Every sensitive action, newest first. Each UTC day is a hash chain whose terminal hash is exported off-box."
      />
      <Notice tone="info" title="Tamper-evident, not tamper-resistant">
        An edited row breaks every later link of its day, so verification shows it. A database superuser could still
        rewrite a whole day before its terminal hash leaves the machine.
      </Notice>

      <Card>
        <CardHeader title={`Chain for ${shownDay}`} subtitle={`${head.rows.toLocaleString("en-IN")} row(s)`} />
        <CardBody className="space-y-3">
          <p className="break-all font-mono text-xs text-text-secondary">Terminal hash {head.hash}</p>
          <AuditVerifyButton day={shownDay} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Filter" subtitle="Actor and action filters need a day." />
        <CardBody>
          <form method="get" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Field label="Day (UTC)" htmlFor="day">
              <Input id="day" name="day" type="date" defaultValue={day} />
            </Field>
            <Field label="Sensitivity" htmlFor="sensitivity">
              <Select id="sensitivity" name="sensitivity" defaultValue={sensitivity ?? ""}>
                <option value="">Any</option>
                {SENSITIVITIES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Target roll number" htmlFor="target">
              <Input id="target" name="target" defaultValue={targetRoll} autoComplete="off" />
            </Field>
            <Field label="Actor roll number (with a day)" htmlFor="actor">
              <Input id="actor" name="actor" defaultValue={actorRoll} autoComplete="off" />
            </Field>
            <Field label="Action (with a day)" htmlFor="action">
              <Input id="action" name="action" defaultValue={action} placeholder="e.g. account.status_changed" />
            </Field>
            <div className="flex items-end lg:col-span-5">
              <button
                type="submit"
                className="inline-flex h-10 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-medium text-primary-fg hover:bg-primary-hover"
              >
                <Search className="h-4 w-4" aria-hidden />
                Apply
              </button>
            </div>
          </form>
        </CardBody>
      </Card>

      {unknownAccount ? (
        <EmptyState compact title="No account has that roll number" />
      ) : rows.length === 0 ? (
        <EmptyState compact title="No audit rows match" />
      ) : (
        <div role="region" tabIndex={0} aria-label="Audit rows" className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[56rem] text-left text-sm">
            <caption className="sr-only">Audit rows, newest first</caption>
            <thead className="bg-primary-subtle/40 text-xs uppercase tracking-wide text-text-secondary">
              <tr>
                <th scope="col" className="px-3 py-2">Id</th>
                <th scope="col" className="px-3 py-2">When</th>
                <th scope="col" className="px-3 py-2">Action</th>
                <th scope="col" className="px-3 py-2">Sensitivity</th>
                <th scope="col" className="px-3 py-2">Actor</th>
                <th scope="col" className="px-3 py-2">Target</th>
                <th scope="col" className="px-3 py-2">Entity</th>
                <th scope="col" className="px-3 py-2">Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border align-top">
                  <td className="px-3 py-2 font-mono text-xs">{r.id}</td>
                  <td className="px-3 py-2 text-xs text-text-secondary">{formatIst(r.createdAt)}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.action}</td>
                  <td className="px-3 py-2">
                    <Badge tone={r.sensitivity === "SECURITY" ? "danger" : r.sensitivity === "SENSITIVE" ? "warning" : "default"}>
                      {r.sensitivity}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-xs">{r.actorId ? (names.get(r.actorId) ?? r.actorId) : "system"}</td>
                  <td className="px-3 py-2 text-xs">{r.targetUserId ? (names.get(r.targetUserId) ?? r.targetUserId) : "—"}</td>
                  <td className="px-3 py-2 text-xs">
                    {r.entityType}
                    {r.entityId ? <span className="block break-all font-mono text-text-secondary">{r.entityId}</span> : null}
                  </td>
                  <td className="max-w-md px-3 py-2">
                    <pre className="whitespace-pre-wrap break-all font-mono text-xs text-text-secondary">
                      {JSON.stringify(r.metadata, null, 1)}
                    </pre>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {nextBefore ? (
        <Link className="text-sm text-primary underline" href={`/super/audit?${next.toString()}`}>
          Older rows
        </Link>
      ) : null}
    </div>
  );
}
