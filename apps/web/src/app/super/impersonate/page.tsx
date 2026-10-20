import type { Metadata } from "next";
import { Search } from "lucide-react";
import { Badge, Card, CardBody, CardHeader, EmptyState, Field, Input } from "@recx/design";
import { requireSuperAdminPage } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { isFeatureEnabled } from "@/lib/flags";
import { namesOf } from "@/server/queries/super-dashboard";
import { ImpersonateForm } from "@/components/super/impersonate-form";
import { formatIst, Notice, PageHeader } from "@/components/super/ui";

export const metadata: Metadata = { title: "Impersonate · Super-admin" };

type Params = Record<string, string | string[] | undefined>;

/**
 * Read-only impersonation (capability "users.impersonate"): an exact roll
 * number or email lookup, a mandatory reason, 15 minutes, no extension.
 * Every change is refused while it lasts. History of the last 50.
 */
export default async function SuperImpersonatePage({ searchParams }: { searchParams: Promise<Params> }) {
  const viewer = await requireSuperAdminPage();
  const params = await searchParams;
  const q = (typeof params.q === "string" ? params.q : "").trim().slice(0, 254);
  const [enabled, target, history] = await Promise.all([
    isFeatureEnabled("impersonation"),
    q
      ? db.user.findFirst({
          where: {
            OR: [
              { collegeId: { equals: q, mode: "insensitive" } },
              { email: { equals: q, mode: "insensitive" } },
            ],
          },
          select: { id: true, collegeId: true, firstName: true, lastName: true, role: true, status: true },
        })
      : null,
    db.impersonationSession.findMany({
      orderBy: { startedAt: "desc" },
      take: 50,
      select: {
        id: true,
        impersonatorId: true,
        targetUserId: true,
        reason: true,
        startedAt: true,
        expiresAt: true,
        endedAt: true,
        endReason: true,
      },
    }),
  ]);
  const names = await namesOf(history.flatMap((h) => [h.impersonatorId, h.targetUserId]));
  const blocked = target
    ? target.id === viewer.id
      ? "You cannot impersonate yourself."
      : target.role === "SUPER_ADMIN"
        ? "A super-admin cannot be impersonated."
        : target.status !== "ACTIVE" && target.status !== "SOFT_RESTRICTED"
          ? `This account is ${target.status}; only active accounts can be viewed.`
          : null
    : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Impersonate"
        description="See the platform exactly as one user sees it, read-only, for at most 15 minutes. The user is not notified; the audit log records the start and the end."
      />
      {!enabled ? <Notice tone="warning" title="Impersonation is switched off (Flags)." /> : null}

      <Card>
        <CardHeader title="Find the account" subtitle="Exact roll number or email." />
        <CardBody className="space-y-4">
          <form method="get" className="flex flex-wrap items-end gap-3">
            <Field label="Roll number or email" htmlFor="q" className="min-w-0 flex-1">
              <Input id="q" name="q" defaultValue={q} autoComplete="off" />
            </Field>
            <button
              type="submit"
              className="inline-flex h-10 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-medium text-primary-fg hover:bg-primary-hover"
            >
              <Search className="h-4 w-4" aria-hidden />
              Find
            </button>
          </form>
          {q && !target ? <p className="text-sm text-text-secondary">No account matches “{q}”.</p> : null}
          {target ? (
            <div className="space-y-3 rounded-xl border border-border p-4">
              <p className="text-sm">
                <span className="font-semibold">
                  {target.firstName} {target.lastName}
                </span>{" "}
                <span className="font-mono">{target.collegeId}</span> · {target.role} · {target.status}
              </p>
              {blocked ? (
                <p className="text-sm text-danger">{blocked}</p>
              ) : enabled ? (
                <ImpersonateForm targetUserId={target.id} collegeId={target.collegeId} />
              ) : null}
            </div>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Recent impersonations" />
        <CardBody>
          {history.length === 0 ? (
            <EmptyState compact title="No impersonation yet" />
          ) : (
            <div tabIndex={0} aria-label="Recent impersonations" className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full min-w-[44rem] text-left text-sm">
                <caption className="sr-only">The last 50 impersonations</caption>
                <thead className="bg-primary-subtle/40 text-xs uppercase tracking-wide text-text-secondary">
                  <tr>
                    <th scope="col" className="px-3 py-2">Started</th>
                    <th scope="col" className="px-3 py-2">By</th>
                    <th scope="col" className="px-3 py-2">Viewing as</th>
                    <th scope="col" className="px-3 py-2">Ended</th>
                    <th scope="col" className="px-3 py-2">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id} className="border-t border-border align-top">
                      <td className="px-3 py-2 text-xs">{formatIst(h.startedAt)}</td>
                      <td className="px-3 py-2 text-xs">{names.get(h.impersonatorId) ?? h.impersonatorId}</td>
                      <td className="px-3 py-2 text-xs">{names.get(h.targetUserId) ?? h.targetUserId}</td>
                      <td className="px-3 py-2 text-xs">
                        {h.endedAt ? (
                          <>
                            {formatIst(h.endedAt)} <Badge>{h.endReason}</Badge>
                          </>
                        ) : (
                          <Badge tone="danger">Live until {formatIst(h.expiresAt)}</Badge>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs break-words">{h.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
