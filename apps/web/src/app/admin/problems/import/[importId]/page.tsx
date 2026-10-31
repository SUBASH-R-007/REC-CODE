import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CheckCircle2, ChevronRight, CircleAlert, Equal, GitBranchPlus, Info } from "lucide-react";
import { Card, CardBody, CardHeader, StatCard } from "@recx/design";
import { requirePageRole } from "@/lib/auth/guards";
import { getImport } from "@/server/queries/admin-problems";
import { AutoRefresh } from "@/components/admin/auto-refresh";
import { ROUTE_ID } from "@/components/admin/problems/rev";
import { ValidateImportedButton } from "@/components/admin/problems/validate-imported-button";

export const metadata: Metadata = { title: "Import" };

const TIME = new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });

const STATUS = {
  CREATED: { label: "Created", Icon: CheckCircle2, className: "text-success" },
  NEW_REVISION: { label: "New revision", Icon: GitBranchPlus, className: "text-info" },
  UNCHANGED: { label: "Unchanged", Icon: Equal, className: "text-text-secondary" },
  FAILED: { label: "Failed", Icon: CircleAlert, className: "text-danger" },
} as const;

/** One import: its counters and a row per problem directory (failed rows first, with every issue and its file). */
export default async function ImportPage({ params }: { params: Promise<{ importId: string }> }) {
  const user = await requirePageRole("ADMIN", "SUPER_ADMIN");
  const { importId } = await params;
  if (!ROUTE_ID.test(importId)) notFound();
  const data = await getImport({ id: user.id, role: user.role }, importId);
  if (!data) notFound();
  const { summary: s, rows } = data;
  const processing = s.status === "PROCESSING";
  const drafts = s.created + s.revised;
  const statusLine = processing
    ? `Importing: ${rows.length} of ${s.total || "?"} problem directories done.`
    : s.status === "FAILED"
      ? `The import stopped: ${s.error ?? "unknown reason"}`
      : `Done: ${s.total} problem directories.`;

  return (
    <div className="space-y-6">
      <nav aria-label="Breadcrumb">
        <ol className="flex flex-wrap items-center gap-1 text-sm text-text-secondary">
          <li>
            <Link href="/admin/problems" className="rounded-md px-1 hover:text-text hover:underline">
              Problems
            </Link>
          </li>
          <li aria-hidden>
            <ChevronRight className="h-3.5 w-3.5" />
          </li>
          <li>
            <Link href="/admin/problems/import" className="rounded-md px-1 hover:text-text hover:underline">
              Import
            </Link>
          </li>
          <li aria-hidden>
            <ChevronRight className="h-3.5 w-3.5" />
          </li>
          <li aria-current="page" className="min-w-0 truncate px-1 font-medium text-text">
            {s.fileName}
          </li>
        </ol>
      </nav>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="break-words font-display text-2xl font-bold tracking-tight">Import {s.fileName}</h1>
          <p role="status" className="mt-1 text-sm text-text-secondary">
            {statusLine}
            {s.uploadedBy ? ` Uploaded by ${s.uploadedBy}.` : ""}
          </p>
        </div>
        {processing && <AutoRefresh updatedLabel={`Updated ${TIME.format(new Date())} IST`} intervalMs={3_000} />}
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Created" value={<span className="tabular-nums">{s.created}</span>} />
        <StatCard label="New revisions" value={<span className="tabular-nums">{s.revised}</span>} />
        <StatCard label="Unchanged" value={<span className="tabular-nums">{s.unchanged}</span>} />
        <StatCard label="Failed" value={<span className="tabular-nums">{s.failed}</span>} />
      </div>

      <ValidateImportedButton importId={s.id} disabled={processing || drafts === 0} />

      <Card>
        <CardHeader title="Problem directories" subtitle="Failed directories first. Fix them and upload the archive again: the rest come back unchanged." />
        <CardBody>
          {rows.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-text-secondary">
              <Info className="h-4 w-4" aria-hidden /> No rows yet.
            </p>
          ) : (
            <div role="region" tabIndex={0} aria-label="Import results" className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-sm">
                <caption className="sr-only">Result of every problem directory in this import</caption>
                <thead className="text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th scope="col" className="py-2 pr-4">
                      Directory
                    </th>
                    <th scope="col" className="py-2 pr-4">
                      Result
                    </th>
                    <th scope="col" className="py-2 pr-4">
                      Problems found
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const st = STATUS[r.status];
                    return (
                      <tr key={r.entry} className="border-t border-border align-top">
                        <td className="py-2 pr-4">
                          {r.problemId ? (
                            <Link
                              href={`/admin/problems/${r.problemId}${r.revision ? `?rev=${r.revision}` : ""}`}
                              className="font-medium text-primary hover:underline"
                            >
                              {r.entry}
                            </Link>
                          ) : (
                            <span className="font-medium">{r.entry}</span>
                          )}
                          {r.revision !== null && <div className="text-xs text-muted">revision {r.revision}</div>}
                        </td>
                        <td className="py-2 pr-4">
                          <span className={`inline-flex items-center gap-1 ${st.className}`}>
                            <st.Icon className="h-3.5 w-3.5" aria-hidden />
                            {st.label}
                          </span>
                        </td>
                        <td className="py-2 pr-4">
                          {r.errors.length === 0 && r.warnings.length === 0 ? (
                            <span className="text-muted">None</span>
                          ) : (
                            <ul className="space-y-1">
                              {r.errors.map((e, n) => (
                                <li key={`e${n}`} className="text-danger">
                                  Error{e.path ? ` in ${e.path}` : ""}: {e.message}
                                </li>
                              ))}
                              {r.warnings.map((w, n) => (
                                <li key={`w${n}`} className="text-text-secondary">
                                  Warning{w.path ? ` in ${w.path}` : ""}: {w.message}
                                </li>
                              ))}
                            </ul>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
