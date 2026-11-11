import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, CardBody, CardHeader, EmptyState } from "@recx/design";
import { requireSuperAdminPage } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { RoleChange } from "@/components/super/role-form";
import { GrantScope, RevokeScope } from "@/components/super/scope-form";
import { formatIst, PageHeader } from "@/components/super/ui";

export const metadata: Metadata = { title: "Roles and scopes · Super-admin" };

function scopeLabel(s: { departmentCode: string | null; batchYear: number | null }): string {
  if (!s.departmentCode && !s.batchYear) return "Whole college";
  return `${s.departmentCode ?? "every department"} · ${s.batchYear ?? "every batch"}`;
}

/**
 * Staff accounts and ADMIN scopes. A student becomes staff from their
 * Users panel; here every staff account can change role and every ADMIN
 * can be granted or lose a department/batch scope. Fail-closed: an ADMIN
 * with no active scope sees no students.
 */
export default async function SuperRolesPage() {
  await requireSuperAdminPage();
  const staff = await db.user.findMany({
    where: { role: { in: ["SUPER_ADMIN", "ADMIN", "TA_MENTOR", "PLACEMENT_OFFICER"] } },
    orderBy: [{ role: "asc" }, { collegeId: "asc" }],
    take: 500,
    select: {
      id: true,
      collegeId: true,
      firstName: true,
      lastName: true,
      role: true,
      status: true,
      adminScopes: {
        where: { revokedAt: null },
        orderBy: { createdAt: "asc" },
        select: { id: true, departmentCode: true, batchYear: true, createdAt: true, reason: true },
      },
    },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Roles and scopes"
        description={
          <>
            Every change is a SECURITY audit row. To make a student staff, open them in{" "}
            <Link className="underline" href="/super/users">
              Users
            </Link>
            .
          </>
        }
      />
      {staff.length === 0 ? (
        <EmptyState title="No staff accounts" />
      ) : (
        <ul className="space-y-3">
          {staff.map((s) => (
            <li key={s.id}>
              <Card>
                <CardHeader
                  title={`${s.firstName} ${s.lastName}`}
                  subtitle={`${s.collegeId} · ${s.status}`}
                  action={<Badge tone={s.role === "SUPER_ADMIN" ? "danger" : "primary"}>{s.role}</Badge>}
                />
                <CardBody className="space-y-3">
                  <div className="flex flex-wrap gap-2">
                    <RoleChange userId={s.id} collegeId={s.collegeId} current={s.role} />
                    {s.role === "ADMIN" ? <GrantScope adminId={s.id} collegeId={s.collegeId} /> : null}
                  </div>
                  {s.role === "ADMIN" ? (
                    s.adminScopes.length === 0 ? (
                      <p className="text-sm text-warning">No active scope: this admin sees no students.</p>
                    ) : (
                      <ul className="space-y-1 text-sm">
                        {s.adminScopes.map((scope) => (
                          <li key={scope.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                            <span className="font-medium">{scopeLabel(scope)}</span>
                            <span className="text-text-secondary">since {formatIst(scope.createdAt)}</span>
                            <RevokeScope scopeId={scope.id} label={scopeLabel(scope)} />
                          </li>
                        ))}
                      </ul>
                    )
                  ) : null}
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
