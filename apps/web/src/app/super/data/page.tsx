import type { Metadata } from "next";
import { Download } from "lucide-react";
import { Card, CardBody, CardHeader, EmptyState } from "@recx/design";
import { requireSuperAdminPage } from "@/lib/auth/guards";
import { PII_EXPORT_COLUMNS, PRIVILEGED_KIND_LABEL } from "@/lib/privileged/payloads";
import { readRetention } from "@/lib/privileged/retention";
import { loadMyDataOperations } from "@/server/queries/super-data";
import { PiiExportForm } from "@/components/super/pii-export-form";
import { PurgeForm } from "@/components/super/purge-form";
import { formatIst, OperationStatusBadge, PageHeader } from "@/components/super/ui";

export const metadata: Metadata = { title: "Data · Super-admin" };

/**
 * PII export and submission purge, both two-person approved. Exports are
 * generated at download time (never stored): requester only, 24 hours, at
 * most 3 downloads, each a SECURITY audit row.
 */
export default async function SuperDataPage() {
  const user = await requireSuperAdminPage();
  const now = new Date();
  const [ops, retention] = await Promise.all([loadMyDataOperations(user.id, now), readRetention()]);

  return (
    <div className="space-y-6">
      <PageHeader title="Data" description="Exports and purges. Each needs a second super-admin's approval." />

      <Card>
        <CardHeader title="PII export" subtitle="Only these minimised columns exist. No passwords, sessions or IP data, ever." />
        <CardBody>
          <PiiExportForm columns={PII_EXPORT_COLUMNS} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Submission source purge" subtitle="One student's practice source code before a date. Verdicts stay." />
        <CardBody>
          <PurgeForm legalHold={retention.legalHold} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Your data requests" />
        <CardBody>
          {ops.length === 0 ? (
            <EmptyState compact title="No data requests yet" />
          ) : (
            <ul className="space-y-2">
              {ops.map((op) => (
                <li key={op.id} className="space-y-1 rounded-xl border border-border p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{PRIVILEGED_KIND_LABEL[op.kind]}</span>
                    <OperationStatusBadge status={op.status} />
                    <span className="text-xs text-text-secondary">{formatIst(op.requestedAt)}</span>
                  </div>
                  <p className="break-words">{op.summary}</p>
                  {op.error ? <p className="text-xs text-danger">{op.error}</p> : null}
                  {op.downloadable ? (
                    <p>
                      <a
                        className="inline-flex items-center gap-1.5 font-medium text-primary underline"
                        href={`/super/data/exports/${encodeURIComponent(op.id)}`}
                        download
                      >
                        <Download className="h-4 w-4" aria-hidden />
                        Download CSV
                      </a>{" "}
                      <span className="text-xs text-text-secondary">
                        ({op.downloadsLeft} download(s) left, until {formatIst(op.availableUntil)})
                      </span>
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
