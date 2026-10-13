import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Eye, EyeOff } from "lucide-react";
import { Card, CardBody, CardHeader, formatBytes } from "@recx/design";
import { requirePageRole } from "@/lib/auth/guards";
import { getDraftTests } from "@/server/queries/admin-problems";
import { ProblemNav } from "@/components/admin/problems/problem-nav";
import { ROUTE_ID, parseRev } from "@/components/admin/problems/rev";
import { StageBadge } from "@/components/admin/problems/stage-badge";
import { AddTestForm, ChangeTestForm, RemoveTestButton, SubtasksForm } from "@/components/admin/problems/tests-panel";
import { DraftSeqProvider } from "@/components/admin/problems/use-action";

export const metadata: Metadata = { title: "Test cases" };

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * The tests of a revision: index, sample flag, subtask, points, sizes, the
 * first bytes of each file and its sha256 prefix (staff only; hidden tests
 * never reach a student page). A DRAFT revision can add, change and remove
 * tests and edit its subtask table.
 */
export default async function TestCasesPage({ params, searchParams }: Props) {
  const user = await requirePageRole("ADMIN", "SUPER_ADMIN");
  const { id } = await params;
  if (!ROUTE_ID.test(id)) notFound();
  const rev = parseRev((await searchParams).rev);
  const data = await getDraftTests({ id: user.id, role: user.role }, id, rev);
  if (!data) notFound();
  const { problem, version, tests, subtasks } = data;

  const table = (
    <div role="region" tabIndex={0} aria-label="Test cases" className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full min-w-[52rem] text-sm">
        <caption className="sr-only">Test cases of revision {version.revision}</caption>
        <thead className="bg-primary-subtle/40 text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            <th scope="col" className="px-3 py-2">
              #
            </th>
            <th scope="col" className="px-3 py-2">
              Visibility
            </th>
            <th scope="col" className="px-3 py-2">
              Subtask
            </th>
            <th scope="col" className="px-3 py-2">
              Points
            </th>
            <th scope="col" className="px-3 py-2">
              In / out size
            </th>
            <th scope="col" className="px-3 py-2">
              First bytes (in → out)
            </th>
            {version.editable && (
              <th scope="col" className="px-3 py-2">
                <span className="sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {tests.map((t) => (
            <tr key={t.index} className="border-t border-border align-top">
              <td className="px-3 py-2 tabular-nums">{t.index}</td>
              <td className="px-3 py-2">
                {t.isSample ? (
                  <span className="inline-flex items-center gap-1 text-text">
                    <Eye className="h-3.5 w-3.5" aria-hidden /> Example
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-text-secondary">
                    <EyeOff className="h-3.5 w-3.5" aria-hidden /> Hidden
                  </span>
                )}
              </td>
              <td className="px-3 py-2 tabular-nums">{t.subtaskIndex ?? "—"}</td>
              <td className="px-3 py-2 tabular-nums">{t.points ?? "—"}</td>
              <td className="px-3 py-2 tabular-nums text-text-secondary">
                {formatBytes(t.inputBytes)} / {formatBytes(t.outputBytes)}
                <div className="font-mono text-[0.7rem] text-muted">
                  {t.inputSha} / {t.outputSha}
                </div>
              </td>
              <td className="px-3 py-2">
                <div className="grid gap-1 sm:grid-cols-2">
                  <pre className="max-h-24 max-w-[16rem] overflow-hidden whitespace-pre-wrap break-all rounded-md bg-background p-1.5 font-mono text-[0.7rem]">
                    {t.inputPreview}
                  </pre>
                  <pre className="max-h-24 max-w-[16rem] overflow-hidden whitespace-pre-wrap break-all rounded-md bg-background p-1.5 font-mono text-[0.7rem]">
                    {t.outputPreview}
                  </pre>
                </div>
              </td>
              {version.editable && (
                <td className="px-3 py-2 text-right">
                  <RemoveTestButton index={t.index} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="space-y-6">
      <ProblemNav problemId={problem.id} displayCode={problem.displayCode} title={problem.title} current="testcases" rev={rev} />
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="font-display text-2xl font-bold tracking-tight">Test cases</h1>
        <span className="flex items-center gap-2 text-sm text-text-secondary">
          Revision {version.revision} <StageBadge stage={version.stage} />
        </span>
        <span className="text-sm text-text-secondary tabular-nums">
          {tests.length} test{tests.length === 1 ? "" : "s"} · {tests.filter((t) => t.isSample).length} shown to students
        </span>
      </header>

      {version.editable ? (
        <DraftSeqProvider versionId={version.id} editSeq={version.editSeq}>
          <Card>
            <CardHeader title="Add a test" subtitle="Every test change means validation must run again." />
            <CardBody>
              <AddTestForm scoring={version.scoringMode} />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Tests" />
            <CardBody className="space-y-4">
              {tests.length === 0 ? <p className="text-sm text-text-secondary">No tests yet.</p> : table}
              <ChangeTestForm tests={tests.map((t) => ({ index: t.index, isSample: t.isSample, subtaskIndex: t.subtaskIndex, points: t.points }))} />
            </CardBody>
          </Card>
          {version.scoringMode === "SUBTASK" && (
            <Card>
              <CardHeader title="Subtasks" />
              <CardBody>
                <SubtasksForm subtasks={subtasks} />
              </CardBody>
            </Card>
          )}
        </DraftSeqProvider>
      ) : (
        <Card>
          <CardHeader
            title="Tests"
            subtitle={version.stage === "IN_REVIEW" || version.stage === "APPROVED" ? "In review: withdraw it to draft to edit tests." : "Frozen with the revision."}
          />
          <CardBody className="space-y-3">
            {tests.length === 0 ? <p className="text-sm text-text-secondary">No tests.</p> : table}
            {subtasks.length > 0 && (
              <p className="text-sm text-text-secondary">
                Subtasks: {subtasks.map((s) => `${s.index} (${s.points} pts${s.dependsOn.length ? `, after ${s.dependsOn.join(", ")}` : ""})`).join(" · ")}
              </p>
            )}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
