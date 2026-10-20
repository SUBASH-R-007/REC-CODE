import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Card, CardBody, CardHeader } from "@recx/design";
import { IMPORT_LIMITS } from "@recx/shared/authoring";
import { requirePageRole } from "@/lib/auth/guards";
import { listMyImports } from "@/server/queries/admin-problems";
import { ImportForm } from "@/components/admin/problems/import-form";

export const metadata: Metadata = { title: "Import problems" };

const DATE = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

/**
 * Bulk import: upload a zip of problem directories (package format 1). Each
 * directory becomes a draft (or a new revision) on its own, so one bad
 * entry never discards the batch; re-uploading the same archive is safe.
 */
export default async function ImportProblemsPage() {
  const user = await requirePageRole("ADMIN", "SUPER_ADMIN");
  const imports = await listMyImports({ id: user.id, role: user.role });
  return (
    <div className="mx-auto max-w-4xl space-y-6">
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
          <li aria-current="page" className="px-1 font-medium text-text">
            Import
          </li>
        </ol>
      </nav>
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">Import problems</h1>
        <p className="mt-1 text-sm text-text-secondary">
          One directory per problem: meta.json, statement.md, testcases/NNN.in and NNN.out, solutions/, and optionally
          checker.cpp, starters/, hints/ and editorial.md (docs/AUTHORING.md). Every problem must be originally authored.
          Imported problems arrive as drafts; nothing is validated or published automatically.
        </p>
      </div>
      <Card>
        <CardBody>
          <ImportForm maxMb={IMPORT_LIMITS.archiveBytes / 1024 / 1024} />
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Your recent imports" />
        <CardBody>
          {imports.length === 0 ? (
            <p className="text-sm text-text-secondary">None yet.</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {imports.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <Link href={`/admin/problems/import/${i.id}`} className="font-medium text-primary hover:underline">
                    {i.fileName}
                  </Link>
                  <span className="text-text-secondary tabular-nums">
                    {i.status === "PROCESSING" ? "Processing" : i.status === "FAILED" ? "Failed" : "Done"} · {i.created} created ·{" "}
                    {i.revised} revised · {i.unchanged} unchanged · {i.failed} failed · {DATE.format(i.startedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
