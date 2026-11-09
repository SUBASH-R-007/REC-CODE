import { Badge, Card, CardBody, CardHeader, EmptyState } from "@recx/design";
import { PROBLEM_REPORT_REASON_LABEL, formatCampusTime, isCorrectnessReport } from "@recx/shared";
import { reportsForProblem } from "@/lib/problems/reports";
import { ClearHold, DecideReport } from "@/components/admin/problems/defect-actions";

/**
 * What students have said about this problem (Phase 16a).
 *
 * High on the page and above the content sections, because an open report
 * saying "case 3 expects 7 and the answer is 6" is the most urgent fact on
 * this screen, and a section nobody scrolls to is a queue nobody works.
 *
 * It shows every report, decided ones included, oldest decision last. A
 * problem with four dismissed reports about the same sentence is telling
 * the author something even though every individual decision was right.
 */
export async function DefectReports({
  problemId,
  hold,
}: {
  problemId: string;
  hold: { reason: string; at: Date } | null;
}) {
  const reports = await reportsForProblem(problemId);
  const open = reports.filter((report) => report.status === "OPEN");

  if (reports.length === 0 && !hold) return null;

  return (
    <Card>
      <CardHeader
        title="Reported defects"
        subtitle="Students saying this problem is wrong. A report changes nothing on its own."
      />
      <CardBody className="space-y-4">
        {hold && (
          <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-warning/30 bg-warning-subtle p-3">
            <div className="min-w-0 space-y-1 text-sm">
              <p className="font-medium">Withheld from new papers</p>
              <p className="text-text-secondary">{hold.reason}</p>
              <p className="text-xs text-muted">
                Since {formatCampusTime(hold.at)}. Practice and existing papers are unaffected.
              </p>
            </div>
            <ClearHold problemId={problemId} />
          </div>
        )}

        {reports.length === 0 ? (
          <EmptyState compact title="No reports" description="Nobody has reported a defect in this problem." />
        ) : (
          <div role="region" tabIndex={0} aria-label="Reported defects" className="overflow-x-auto">
            <table className="w-full min-w-[46rem] border-collapse text-sm">
              <caption className="sr-only">
                Every defect report on this problem: {open.length} open of {reports.length}.
              </caption>
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                  <th scope="col" className="py-2 pr-3">
                    Status
                  </th>
                  <th scope="col" className="py-2 pr-3">
                    Rev
                  </th>
                  <th scope="col" className="py-2 pr-3">
                    What they say
                  </th>
                  <th scope="col" className="py-2 pr-3">
                    Reported
                  </th>
                  <th scope="col" className="py-2">
                    <span className="sr-only">Answer</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {reports.map((report) => (
                  <tr key={report.id} className="border-b border-border/60 align-top">
                    <td className="py-3 pr-3">
                      <Badge
                        tone={
                          report.status === "OPEN"
                            ? isCorrectnessReport(report.reason)
                              ? "danger"
                              : "warning"
                            : report.status === "UPHELD"
                              ? "success"
                              : "default"
                        }
                      >
                        {report.status === "OPEN" ? "Open" : report.status === "UPHELD" ? "Upheld" : "Dismissed"}
                      </Badge>
                    </td>
                    <td className="py-3 pr-3 font-mono text-xs">{report.revision}</td>
                    <td className="py-3 pr-3">
                      <p className="font-medium">{PROBLEM_REPORT_REASON_LABEL[report.reason]}</p>
                      <p className="mt-1 whitespace-pre-wrap text-text-secondary">{report.detail}</p>
                      {report.resolution && (
                        <p className="mt-2 border-l-2 border-border pl-2 text-xs text-muted">
                          Answered: {report.resolution}
                        </p>
                      )}
                    </td>
                    <td className="py-3 pr-3 text-xs text-muted">{formatCampusTime(report.createdAt)}</td>
                    <td className="py-3">
                      {report.status === "OPEN" && (
                        <DecideReport reportId={report.id} reason={PROBLEM_REPORT_REASON_LABEL[report.reason]} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
