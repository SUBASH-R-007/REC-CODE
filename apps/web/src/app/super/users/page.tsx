import type { Metadata } from "next";
import Link from "next/link";
import { Eye, Search } from "lucide-react";
import { Badge, ButtonLink, Card, CardBody, CardHeader, EmptyState, Field, Input, Select } from "@recx/design";
import { requireSuperAdminPage } from "@/lib/auth/guards";
import { loadUserPanel, parseUserSearch, searchAsFilter, searchUsers } from "@/server/queries/super-users";
import { BulkStatusTable } from "@/components/super/bulk-status-form";
import { RoleChange } from "@/components/super/role-form";
import { StatusChange } from "@/components/super/status-dialog";
import { formatIst, PageHeader } from "@/components/super/ui";
import { VoidXpButton } from "@/components/super/xp-ledger";

export const metadata: Metadata = { title: "Users · Super-admin" };

type Params = Record<string, string | string[] | undefined>;

async function UserPanel({ userId }: { userId: string }) {
  const panel = await loadUserPanel(userId);
  if (!panel) return <EmptyState compact title="That account was not found" />;
  const { user, history, xp } = panel;
  return (
    <Card>
      <CardHeader
        title={`${user.firstName} ${user.lastName}`}
        subtitle={`${user.collegeId} · ${user.role} · ${user.status}`}
        action={
          <Link className="text-sm text-primary underline" href="/super/users">
            Close
          </Link>
        }
      />
      <CardBody className="space-y-5">
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <div>
            <dt className="inline font-medium">Email </dt>
            <dd className="inline break-all">{user.email}</dd>
          </div>
          <div>
            <dt className="inline font-medium">Cohort </dt>
            <dd className="inline">
              {[user.departmentCode, user.batchYear, user.section].filter(Boolean).join(" · ") || "—"}
            </dd>
          </div>
          <div>
            <dt className="inline font-medium">Last active </dt>
            <dd className="inline">{formatIst(user.lastActiveAt)}</dd>
          </div>
          <div>
            <dt className="inline font-medium">XP total (maintained) </dt>
            <dd className="inline">{user.stats?.xpTotal ?? 0}</dd>
          </div>
        </dl>
        <div className="flex flex-wrap gap-2">
          <StatusChange userId={user.id} collegeId={user.collegeId} current={user.status} />
          <RoleChange userId={user.id} collegeId={user.collegeId} current={user.role} />
          {user.role !== "SUPER_ADMIN" && (user.status === "ACTIVE" || user.status === "SOFT_RESTRICTED") ? (
            <ButtonLink size="sm" variant="outline" href={`/super/impersonate?q=${encodeURIComponent(user.collegeId)}`}>
              <Eye className="h-3.5 w-3.5" aria-hidden />
              Impersonate
            </ButtonLink>
          ) : null}
        </div>

        <section aria-labelledby="history-heading">
          <h3 id="history-heading" className="mb-2 font-semibold">
            Account history (audit log)
          </h3>
          {history.length === 0 ? (
            <p className="text-sm text-text-secondary">No account changes recorded.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {history.map((h) => (
                <li key={h.id} className="flex flex-wrap gap-x-3">
                  <span className="text-text-secondary">{formatIst(h.createdAt)}</span>
                  <span className="font-mono">{h.action}</span>
                  <Badge tone={h.sensitivity === "SECURITY" ? "danger" : "default"}>{h.sensitivity}</Badge>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="xp-heading">
          <h3 id="xp-heading" className="mb-2 font-semibold">
            Last 50 XP ledger rows
          </h3>
          {xp.length === 0 ? (
            <p className="text-sm text-text-secondary">No XP events.</p>
          ) : (
            <div tabIndex={0} aria-label="XP ledger" className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full min-w-[32rem] text-left text-sm">
                <caption className="sr-only">The latest XP ledger rows of this account</caption>
                <thead className="bg-primary-subtle/40 text-xs uppercase tracking-wide text-text-secondary">
                  <tr>
                    <th scope="col" className="px-3 py-2">Id</th>
                    <th scope="col" className="px-3 py-2">Kind</th>
                    <th scope="col" className="px-3 py-2">XP</th>
                    <th scope="col" className="px-3 py-2">When</th>
                    <th scope="col" className="px-3 py-2">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {xp.map((e) => (
                    <tr key={e.id} className="border-t border-border">
                      <td className="px-3 py-2 font-mono">{e.id}</td>
                      <td className="px-3 py-2">{e.kind}</td>
                      <td className="px-3 py-2 tabular-nums">{e.amount}</td>
                      <td className="px-3 py-2 text-text-secondary">{formatIst(e.occurredAt)}</td>
                      <td className="px-3 py-2">
                        {e.kind === "REVERSAL" ? (
                          <span className="text-xs text-text-secondary">reverses #{e.reversesEventId}</span>
                        ) : e.voided ? (
                          <Badge>Voided</Badge>
                        ) : e.amount > 0 ? (
                          <VoidXpButton eventId={e.id} label={`event #${e.id} (${e.amount} XP)`} />
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </CardBody>
    </Card>
  );
}

/**
 * Accounts: find (exact roll number or email, plus filters), change status
 * (one, up to 25 directly, more by two-person request), change role, void
 * XP, start an impersonation.
 */
export default async function SuperUsersPage({ searchParams }: { searchParams: Promise<Params> }) {
  await requireSuperAdminPage();
  const params = await searchParams;
  const search = parseUserSearch(params);
  const { rows, nextAfter } = await searchUsers(search);
  const filter = searchAsFilter(search);
  const filterLabel = filter
    ? Object.entries(filter)
        .map(([k, v]) => `${k} ${Array.isArray(v) ? v.join("/") : String(v)}`)
        .join(", ")
    : "";
  const panelUser = typeof params.user === "string" ? params.user.slice(0, 64) : null;
  const nextParams = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (typeof v === "string" && k !== "after" && k !== "user") nextParams.set(k, v);
  if (nextAfter) nextParams.set("after", nextAfter);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users"
        description="Status and role changes, XP voids and impersonation. Up to 25 accounts change directly; more needs a second super-admin."
      />

      {panelUser ? <UserPanel userId={panelUser} /> : null}

      <Card>
        <CardHeader title="Find accounts" subtitle="An exact roll number or email, or filters. 50 per page." />
        <CardBody>
          <form method="get" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
            <Field label="Roll number or email" htmlFor="q" className="lg:col-span-2">
              <Input id="q" name="q" defaultValue={search.q ?? ""} autoComplete="off" />
            </Field>
            <Field label="Role" htmlFor="role">
              <Select id="role" name="role" defaultValue={search.role ?? ""}>
                <option value="">Any</option>
                <option value="STUDENT">Student</option>
                <option value="TA_MENTOR">TA / mentor</option>
                <option value="ADMIN">Admin</option>
                <option value="PLACEMENT_OFFICER">Placement officer</option>
                <option value="SUPER_ADMIN">Super-admin</option>
              </Select>
            </Field>
            <Field label="Status" htmlFor="status">
              <Select id="status" name="status" defaultValue={search.status ?? ""}>
                <option value="">Any</option>
                <option value="ACTIVE">Active</option>
                <option value="SOFT_RESTRICTED">Soft-restricted</option>
                <option value="DISABLED">Disabled</option>
                <option value="GRADUATED">Graduated</option>
                <option value="ARCHIVED">Archived</option>
              </Select>
            </Field>
            <Field label="Batch" htmlFor="batch">
              <Input id="batch" name="batch" inputMode="numeric" defaultValue={search.batchYear ?? ""} />
            </Field>
            <Field label="Department" htmlFor="dept">
              <Input id="dept" name="dept" defaultValue={search.departmentCode ?? ""} />
            </Field>
            <div className="flex items-end lg:col-span-6">
              <button
                type="submit"
                className="inline-flex h-10 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-medium text-primary-fg hover:bg-primary-hover"
              >
                <Search className="h-4 w-4" aria-hidden />
                Search
              </button>
            </div>
          </form>
        </CardBody>
      </Card>

      {rows.length === 0 ? (
        <EmptyState title="No account matches" description="Check the roll number, or widen the filters." />
      ) : (
        <BulkStatusTable
          filter={filter}
          filterLabel={filterLabel}
          rows={rows.map((r) => ({
            id: r.id,
            collegeId: r.collegeId,
            name: `${r.firstName} ${r.lastName}`,
            role: r.role,
            status: r.status,
            cohort: [r.departmentCode, r.batchYear, r.section].filter(Boolean).join(" · ") || "—",
          }))}
        />
      )}
      {nextAfter ? (
        <div>
          <Link className="text-sm text-primary underline" href={`/super/users?${nextParams.toString()}`}>
            Next 50 accounts
          </Link>
        </div>
      ) : null}
    </div>
  );
}
