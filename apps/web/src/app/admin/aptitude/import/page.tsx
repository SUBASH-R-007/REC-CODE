import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@recx/design";
import { requirePageRole } from "@/lib/auth/guards";
import { listAptitudeImports } from "@/server/queries/admin-aptitude";
import { AdminPageHeader, TBODY_ROW, TD, TH, THEAD_ROW, TableFrame, formatDateTime } from "@/components/admin/admin-ui";
import { AptitudeImportForm } from "@/components/admin/aptitude/import-form";

export const metadata: Metadata = { title: "Import aptitude questions" };

type SearchParams = Promise<{ page?: string | string[] }>;

/**
 * `/admin/aptitude/import` — upload a CSV, and the history of every upload
 * (Phase 7d).
 *
 * The history is the point as much as the form: SPEC §5 wants per-row
 * results, and a result an operator cannot come back to tomorrow is a result
 * they have to re-derive by uploading again.
 */
export default async function AptitudeImportPage({ searchParams }: { searchParams: SearchParams }) {
  await requirePageRole("ADMIN", "SUPER_ADMIN");
  const raw = (await searchParams).page;
  const page = Number((Array.isArray(raw) ? raw[0] : raw) ?? "1") || 1;
  const history = await listAptitudeImports(page);

  return (
    <div className="space-y-8">
      <AdminPageHeader
        title="Import aptitude questions"
        description="A CSV from the LMS question bank, or an export from here with your corrections. One bad row never discards the file."
        back={{ href: "/admin/aptitude", label: "Aptitude bank" }}
      />

      <AptitudeImportForm />

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Earlier uploads</h2>
        {history.rows.length === 0 ? (
          <p className="text-sm text-text-secondary">Nothing has been imported yet.</p>
        ) : (
          <TableFrame label="Import history">
            <thead>
              <tr className={THEAD_ROW}>
                <th className={TH}>File</th>
                <th className={TH}>When</th>
                <th className={TH}>Result</th>
                <th className={TH}>Created</th>
                <th className={TH}>Revised</th>
                <th className={TH}>Unchanged</th>
                <th className={TH}>Failed</th>
              </tr>
            </thead>
            <tbody>
              {history.rows.map((row) => (
                <tr key={row.id} className={TBODY_ROW}>
                  <td className={TD}>
                    <Link href={`/admin/aptitude/import/${row.id}`} className="text-primary underline">
                      {row.fileName}
                    </Link>
                    <div className="text-xs text-muted">
                      {Math.max(1, Math.round(row.sizeBytes / 1024))} KB · {row.via}
                      {row.defaultTopic ? ` · default ${row.defaultTopic}` : ""}
                    </div>
                  </td>
                  <td className={TD}>{formatDateTime(row.startedAt)}</td>
                  <td className={TD}>
                    <Badge tone={row.status === "DONE" ? "success" : row.status === "FAILED" ? "danger" : "info"}>
                      {row.status.toLowerCase()}
                    </Badge>
                    {row.error ? <div className="mt-1 max-w-sm text-xs text-danger">{row.error}</div> : null}
                  </td>
                  <td className={TD}>{row.created}</td>
                  <td className={TD}>{row.revised}</td>
                  <td className={TD}>{row.unchanged}</td>
                  <td className={TD}>
                    {row.failed > 0 ? <span className="text-warning">{row.failed}</span> : row.failed}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableFrame>
        )}

        {history.pageCount > 1 ? (
          <nav className="flex items-center gap-3 text-sm" aria-label="Pages">
            {history.page > 1 ? (
              <Link href={`/admin/aptitude/import?page=${history.page - 1}`} className="text-primary underline">
                Previous
              </Link>
            ) : null}
            <span className="text-text-secondary">
              Page {history.page} of {history.pageCount}
            </span>
            {history.page < history.pageCount ? (
              <Link href={`/admin/aptitude/import?page=${history.page + 1}`} className="text-primary underline">
                Next
              </Link>
            ) : null}
          </nav>
        ) : null}
      </section>
    </div>
  );
}
