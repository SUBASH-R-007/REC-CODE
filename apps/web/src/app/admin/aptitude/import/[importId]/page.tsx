import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@recx/design";
import { requirePageRole } from "@/lib/auth/guards";
import { getAptitudeImport } from "@/server/queries/admin-aptitude";
import { AdminPageHeader, TBODY_ROW, TD, TH, THEAD_ROW, TableFrame, formatDateTime } from "@/components/admin/admin-ui";

export const metadata: Metadata = { title: "Import result" };

type Issue = { path?: string; message?: string };

/**
 * `/admin/aptitude/import/[importId]` — every line of one upload (Phase 7d).
 *
 * This page is what SPEC §5's "per-row results" means in practice: failures
 * first, because an operator opening it is here to fix them, and every reason
 * for each failure rather than the first — a row that reports one problem at
 * a time makes somebody upload the file once per mistake.
 *
 * Paged at 50, like every other staff list: a 2,000-row import is 2,000 rows.
 */
export default async function AptitudeImportResultPage({
  params,
  searchParams,
}: {
  params: Promise<{ importId: string }>;
  searchParams: Promise<{ page?: string | string[] }>;
}) {
  await requirePageRole("ADMIN", "SUPER_ADMIN");
  const { importId } = await params;
  const raw = (await searchParams).page;
  const page = Number((Array.isArray(raw) ? raw[0] : raw) ?? "1") || 1;

  const result = await getAptitudeImport(importId, page);
  if (!result) notFound();
  const { import: record, rows } = result;

  const issues = (value: unknown): Issue[] => (Array.isArray(value) ? (value as Issue[]) : []);

  return (
    <div className="space-y-6">
      <AdminPageHeader
        title={record.fileName}
        description={`${record.total} row${record.total === 1 ? "" : "s"} · uploaded ${formatDateTime(record.startedAt)}${
          record.finishedAt ? ` · finished ${formatDateTime(record.finishedAt)}` : ""
        }`}
        back={{ href: "/admin/aptitude/import", label: "Import aptitude questions" }}
        actions={
          <Badge tone={record.status === "DONE" ? "success" : record.status === "FAILED" ? "danger" : "info"}>
            {record.status.toLowerCase()}
          </Badge>
        }
      />

      {record.error ? (
        <div className="space-y-1 rounded-md border border-danger/30 bg-danger-subtle p-4 text-sm text-danger">
          <p className="font-medium">Nothing was imported from this file.</p>
          <p>{record.error}</p>
          <p className="text-danger/80">
            A problem with the header, the size or the quoting means no row in the file is trusted — so none of them was
            applied. Fix the file and upload it again.
          </p>
        </div>
      ) : (
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ["Created", record.created],
            ["Revised", record.revised],
            ["Unchanged", record.unchanged],
            ["Failed", record.failed],
          ].map(([label, value]) => (
            <div key={String(label)} className="rounded-md border border-border p-3">
              <dt className="text-xs uppercase tracking-wide text-muted">{label}</dt>
              <dd className="text-xl font-semibold">{value}</dd>
            </div>
          ))}
        </dl>
      )}

      {record.defaultTopic ? (
        <p className="text-sm text-text-secondary">
          Rows that named no topic were imported as <strong>{record.defaultTopic}</strong>
          {record.defaultArea ? ` (${record.defaultArea.toLowerCase()})` : ""}. That choice is recorded with the file,
          because a bank imported under the wrong topic is a weakness view that misleads a student about themselves.
        </p>
      ) : null}

      {rows.length === 0 ? null : (
        <TableFrame label="Rows">
          <thead>
            <tr className={THEAD_ROW}>
              <th className={TH}>Line</th>
              <th className={TH}>Result</th>
              <th className={TH}>Question</th>
              <th className={TH}>What happened</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.line} className={TBODY_ROW}>
                <td className={TD}>{row.line}</td>
                <td className={TD}>
                  <Badge
                    tone={
                      row.status === "FAILED"
                        ? "danger"
                        : row.status === "CREATED"
                          ? "success"
                          : row.status === "NEW_REVISION"
                            ? "info"
                            : "default"
                    }
                  >
                    {row.status === "NEW_REVISION" ? "revised" : row.status.toLowerCase()}
                  </Badge>
                </td>
                <td className={TD}>
                  {row.questionId ? (
                    <Link href={`/admin/aptitude/${row.questionId}`} className="text-primary underline">
                      {row.displayCode ?? "Open"}
                    </Link>
                  ) : (
                    <span className="text-muted">{row.displayCode ?? "—"}</span>
                  )}
                </td>
                <td className={TD}>
                  {issues(row.errors).length > 0 ? (
                    <ul className="space-y-1 text-sm text-danger">
                      {issues(row.errors).map((issue, index) => (
                        <li key={index}>{issue.message ?? "Refused."}</li>
                      ))}
                    </ul>
                  ) : null}
                  {issues(row.warnings).length > 0 ? (
                    <ul className="mt-1 space-y-1 text-xs text-warning">
                      {issues(row.warnings).map((issue, index) => (
                        <li key={index}>{issue.message}</li>
                      ))}
                    </ul>
                  ) : null}
                  {issues(row.errors).length === 0 && issues(row.warnings).length === 0 ? (
                    <span className="text-muted">—</span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </TableFrame>
      )}

      {result.pageCount > 1 ? (
        <nav className="flex items-center gap-3 text-sm" aria-label="Pages">
          {result.page > 1 ? (
            <Link
              href={`/admin/aptitude/import/${record.id}?page=${result.page - 1}`}
              className="text-primary underline"
            >
              Previous
            </Link>
          ) : null}
          <span className="text-text-secondary">
            Page {result.page} of {result.pageCount}
          </span>
          {result.page < result.pageCount ? (
            <Link
              href={`/admin/aptitude/import/${record.id}?page=${result.page + 1}`}
              className="text-primary underline"
            >
              Next
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
