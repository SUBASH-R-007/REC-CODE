import type { Metadata } from "next";
import { FileUp, UsersRound } from "lucide-react";
import { ButtonLink, Card, EmptyState } from "@recx/design";
import { describeScope, isEmptyScope, requireAdminScopePage } from "@/lib/auth/scope";
import { filtersToQuery, hasFilters, parseStudentFilters } from "@/lib/admin/student-filters";
import { listStudents } from "@/server/queries/admin-students";
import { AdminPageHeader } from "@/components/admin/admin-ui";
import { StudentFiltersForm } from "@/components/admin/students/student-filters";
import { StudentTable } from "@/components/admin/students/student-table";

export const metadata: Metadata = { title: "Students" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Students in the viewer's scope, filtered from the URL, 50 per page by roll
 * number. Identities are managed in REC Learning (the LMS): this page reads
 * them and links to each student's admin view.
 */
export default async function AdminStudentsPage({ searchParams }: { searchParams: SearchParams }) {
  const { scope } = await requireAdminScopePage();
  const filters = parseStudentFilters(await searchParams);
  const list = await listStudents(scope, filters);

  return (
    <>
      <AdminPageHeader
        title="Students"
        description={
          <>
            Scope: {describeScope(scope)}. Names, roll numbers and cohorts are managed in REC Learning and arrive by roster
            import.
          </>
        }
        actions={
          <ButtonLink href="/admin/students/import" variant="outline">
            <FileUp className="h-4 w-4" aria-hidden />
            Import a roster
          </ButtonLink>
        }
      />
      <Card className="p-5">
        <StudentFiltersForm filters={filters} />
      </Card>

      <h2 className="mt-6 text-sm font-medium text-text-secondary tabular-nums" aria-live="polite">
        {list.total.toLocaleString("en-IN")} {list.total === 1 ? "student" : "students"}
        {hasFilters(filters) ? " match these filters" : ""}
      </h2>
      <Card className="mt-2 overflow-hidden">
        {list.rows.length === 0 ? (
          <EmptyState
            icon={<UsersRound className="h-6 w-6" />}
            title={isEmptyScope(scope) ? "No students are assigned to you" : "No students found"}
            description={
              isEmptyScope(scope)
                ? "A super-admin grants each administrator a department and/or batch."
                : "Try a different roll number or name, or clear the filters."
            }
          />
        ) : (
          <StudentTable rows={list.rows} />
        )}
      </Card>
      {(filters.after || list.nextAfter) && (
        <nav aria-label="Student pages" className="mt-4 flex flex-wrap justify-between gap-3">
          {filters.after ? (
            <ButtonLink href={`/admin/students${filtersToQuery(filters, { after: undefined })}`} variant="ghost">
              First page
            </ButtonLink>
          ) : (
            <span />
          )}
          {list.nextAfter ? (
            <ButtonLink href={`/admin/students${filtersToQuery(filters, { after: list.nextAfter })}`} variant="outline">
              Next page
            </ButtonLink>
          ) : null}
        </nav>
      )}
    </>
  );
}
