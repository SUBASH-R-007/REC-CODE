import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CircleCheck, Clock } from "lucide-react";
import { ButtonLink, Card, CardHeader, EmptyState } from "@recx/design";
import { requireAdminScopePage } from "@/lib/auth/scope";
import { getImportPreview } from "@/server/queries/admin-roster";
import { AdminPageHeader, TableFrame, TBODY_ROW, TD, TH, THEAD_ROW, formatDateTime } from "@/components/admin/admin-ui";
import { RosterCountsList, RosterDiff } from "@/components/admin/roster/diff-table";
import { RosterCommitForm } from "@/components/admin/roster/commit-form";

export const metadata: Metadata = { title: "Roster import" };

type Params = Promise<{ importId: string }>;

const SHOW_RESULTS = 300;

/**
 * One roster import. While it is a preview, the plan is recomputed from the
 * stored rows at every render (against the accounts as they are now) and the
 * commit carries the hash of exactly this diff. After the commit only line
 * numbers, outcomes and changed field names remain — the rows are dropped.
 */
export default async function RosterImportPreviewPage({ params }: { params: Params }) {
  const { user, scope } = await requireAdminScopePage();
  const { importId } = await params;
  const view = await getImportPreview(user, scope, importId);
  if (!view) notFound();
  const s = view.summary;
  const back = { href: "/admin/students/import", label: "Import a roster" };

  if (view.kind === "closed") {
    return (
      <>
        <AdminPageHeader title={s.fileName} back={back} />
        <Card>
          <EmptyState
            icon={<Clock className="h-6 w-6" />}
            title="This preview is closed"
            description="It was discarded or expired after an hour, and its rows were dropped. Upload the file again to preview it."
            action={<ButtonLink href="/admin/students/import">Upload again</ButtonLink>}
          />
        </Card>
      </>
    );
  }

  if (view.kind === "committed") {
    const shown = view.results.slice(0, SHOW_RESULTS);
    return (
      <>
        <AdminPageHeader
          title={s.fileName}
          back={back}
          description={
            <span className="inline-flex items-center gap-1.5">
              <CircleCheck className="h-4 w-4 text-success" aria-hidden />
              Committed {formatDateTime(s.committedAt)}
            </span>
          }
        />
        {s.counts ? (
          <Card className="p-5">
            <RosterCountsList counts={s.counts} />
          </Card>
        ) : null}
        <Card className="mt-6 overflow-hidden">
          <CardHeader title="What happened, line by line" subtitle="Line numbers, outcomes and the names of changed fields." />
          <div className="pb-4 pt-3">
            <TableFrame label="Import results">
              <table className="w-full text-sm">
                <caption className="sr-only">Import results by line</caption>
                <thead>
                  <tr className={THEAD_ROW}>
                    <th scope="col" className={TH}>
                      Line
                    </th>
                    <th scope="col" className={TH}>
                      Outcome
                    </th>
                    <th scope="col" className={TH}>
                      Details
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.line} className={TBODY_ROW}>
                      <td className={`${TD} tabular-nums`}>{r.line}</td>
                      <td className={`${TD} text-xs`}>{r.outcome.toLowerCase()}</td>
                      <td className={`${TD} text-xs text-text-secondary`}>
                        {[
                          r.changedFields?.length ? `changed: ${r.changedFields.join(", ")}` : null,
                          r.linked ? "LMS id linked" : null,
                          r.reason ? r.reason.toLowerCase().replace(/_/g, " ") : null,
                        ]
                          .filter(Boolean)
                          .join(" · ") || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableFrame>
            {view.results.length > shown.length ? (
              <p className="px-5 pt-3 text-xs text-text-secondary tabular-nums">
                Showing the first {shown.length} of {view.results.length} lines.
              </p>
            ) : null}
          </div>
        </Card>
      </>
    );
  }

  const changes = view.plan.counts.create + view.plan.lines.filter((l) => l.outcome.kind === "UPDATE").length;
  return (
    <>
      <AdminPageHeader
        title={`Preview: ${s.fileName}`}
        back={back}
        description={`Nothing has changed yet. This preview expires ${formatDateTime(s.expiresAt)}.`}
      />
      <Card className="p-5">
        <RosterCountsList counts={view.plan.counts} />
        <div className="mt-5 border-t border-border pt-5">
          <RosterCommitForm importId={s.id} diffSha256={view.diffSha256} changes={changes} />
        </div>
      </Card>
      <Card className="mt-6 py-5">
        <RosterDiff plan={view.plan} />
      </Card>
    </>
  );
}
