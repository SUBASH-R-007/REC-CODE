import type { Metadata } from "next";
import Link from "next/link";
import { FileClock } from "lucide-react";
import { Card, CardHeader, EmptyState } from "@recx/design";
import { ROSTER_COLUMNS, ROSTER_IMPORT_LIMITS } from "@recx/shared";
import { describeScope, requireAdminScopePage } from "@/lib/auth/scope";
import { listRecentImports } from "@/server/queries/admin-roster";
import { AdminPageHeader, TableFrame, TBODY_ROW, TD, TH, THEAD_ROW, formatDateTime } from "@/components/admin/admin-ui";
import { RosterImportForm } from "@/components/admin/roster/import-form";

export const metadata: Metadata = { title: "Import a roster" };

/**
 * Upload an LMS roster export for a dry run. REC Code never creates an
 * identity of its own: every row copies a person who already exists in REC
 * Learning, and the import never changes a role, an account status or a
 * password.
 */
export default async function RosterImportPage() {
  const { user, scope } = await requireAdminScopePage();
  const recent = await listRecentImports(user);
  const maxKb = Math.round(ROSTER_IMPORT_LIMITS.maxBytes / 1024);

  return (
    <>
      <AdminPageHeader
        title="Import a roster"
        back={{ href: "/admin/students", label: "All students" }}
        description={`Rows outside your scope (${describeScope(scope)}) are rejected in the preview.`}
      />
      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="min-w-0 p-5 lg:col-span-3">
          <RosterImportForm maxKb={maxKb} />
        </Card>
        <Card className="min-w-0 lg:col-span-2">
          <CardHeader title="File format" />
          <div className="space-y-3 px-5 pb-5 pt-3 text-sm text-text-secondary">
            <p>The first line must be exactly:</p>
            <pre
              className="overflow-x-auto rounded-lg border border-border bg-background p-3 font-mono text-xs text-text"
              tabIndex={0}
              aria-label="Required header"
            >
              {ROSTER_COLUMNS.join(",")}
            </pre>
            <ul className="list-disc space-y-1 pl-5">
              <li>Every row needs its LMS user id. Rows without one are rejected.</li>
              <li>Existing students are matched by LMS id, roll number and email; their names, email and cohort are refreshed.</li>
              <li>A changed roll number, a key that points at two accounts, and staff accounts are left for a super-admin.</li>
              <li>Students missing from the file are not changed.</li>
              <li>New accounts cannot sign in until sign-in through REC Learning is available.</li>
            </ul>
          </div>
        </Card>
      </div>

      <Card className="mt-6 overflow-hidden">
        <CardHeader title={user.role === "SUPER_ADMIN" ? "Recent imports" : "Your recent imports"} />
        <div className="pb-4 pt-3">
          {recent.length === 0 ? (
            <EmptyState compact icon={<FileClock className="h-5 w-5" />} title="No imports yet" />
          ) : (
            <TableFrame label="Recent imports">
              <table className="w-full text-sm">
                <caption className="sr-only">Recent roster imports</caption>
                <thead>
                  <tr className={THEAD_ROW}>
                    <th scope="col" className={TH}>
                      File
                    </th>
                    <th scope="col" className={TH}>
                      Status
                    </th>
                    <th scope="col" className={`${TH} text-right`}>
                      Rows
                    </th>
                    <th scope="col" className={TH}>
                      Uploaded
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((r) => (
                    <tr key={r.id} className={TBODY_ROW}>
                      <td className={TD}>
                        <Link href={`/admin/students/import/${r.id}` as never} className="font-medium hover:text-primary hover:underline">
                          {r.fileName}
                        </Link>
                      </td>
                      <td className={`${TD} text-xs`}>{r.status.toLowerCase()}</td>
                      <td className={`${TD} text-right tabular-nums`}>{r.rowCount}</td>
                      <td className={`${TD} whitespace-nowrap`}>{formatDateTime(r.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableFrame>
          )}
        </div>
      </Card>
    </>
  );
}
