import Link from "next/link";
import type { StudentListRow } from "@/server/queries/admin-students";
import { formatCohort } from "@/lib/admin/cohort";
import { AccountStatusBadge, TableFrame, TBODY_ROW, TD, TH, THEAD_ROW, formatDate } from "@/components/admin/admin-ui";

/** One page of students (50 rows; keyset paging, so never 5,000 DOM rows). */
export function StudentTable({ rows }: { rows: StudentListRow[] }) {
  return (
    <TableFrame label="Students">
      <table className="w-full text-sm">
        <caption className="sr-only">Students in your scope</caption>
        <thead>
          <tr className={THEAD_ROW}>
            <th scope="col" className={TH}>
              Student
            </th>
            <th scope="col" className={TH}>
              Cohort
            </th>
            <th scope="col" className={TH}>
              Status
            </th>
            <th scope="col" className={`${TH} text-right`}>
              Solved
            </th>
            <th scope="col" className={`${TH} text-right`}>
              Streak
            </th>
            <th scope="col" className={TH}>
              Last active
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id} className={TBODY_ROW}>
              <th scope="row" className={`${TD} text-left font-normal`}>
                <Link href={`/admin/students/${s.id}` as never} className="font-medium text-text hover:text-primary hover:underline">
                  {s.firstName} {s.lastName}
                </Link>
                <span className="block font-mono text-xs text-text-secondary">{s.collegeId}</span>
              </th>
              <td className={`${TD} whitespace-nowrap`}>{formatCohort(s)}</td>
              <td className={TD}>
                <AccountStatusBadge status={s.status} />
              </td>
              <td className={`${TD} text-right tabular-nums`}>{s.solvedTotal}</td>
              <td className={`${TD} text-right tabular-nums`}>{s.currentStreak}</td>
              <td className={`${TD} whitespace-nowrap`}>{s.lastActiveAt ? formatDate(s.lastActiveAt) : "Never"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableFrame>
  );
}
