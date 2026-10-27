import type { Metadata } from "next";
import { Card, CardHeader } from "@recx/design";
import { ROSTER_COLUMNS } from "@recx/shared";
import { describeScope, requireAdminScopePage } from "@/lib/auth/scope";
import { AdminPageHeader } from "@/components/admin/admin-ui";
import { AddStudentForm } from "@/components/admin/roster/add-student-form";

export const metadata: Metadata = { title: "Add a student" };

/**
 * `/admin/students/new` — one student, for the late admission and the
 * transfer that arrive between roster syncs. Until this page, an ADMIN's
 * only way to add a person was to write a CSV of one row and import it.
 *
 * It is deliberately NOT a second way to create a student: the action
 * behind it (`admin-roster#addStudent`) validates with the roster's own
 * schema, decides conflicts and scope with the roster's own planner, and
 * writes through the roster's own apply step. Anything that is not a clean
 * creation — a roll number already in use, a cohort outside this admin's
 * scope — comes back as the planner's refusal.
 *
 * An account created here has NO password, exactly like an imported one.
 * The student sets their own through the one-time link; nobody chooses a
 * password for somebody else (docs/SECURITY.md §2).
 */
export default async function AddStudentPage() {
  const { scope } = await requireAdminScopePage();

  /**
   * Prefill from the scope when it names exactly one cohort: an ADMIN
   * scoped to CSE 2027 is adding a CSE 2027 student nine times out of ten,
   * and the planner rejects anything else anyway. A broader scope prefills
   * only the batch year, which is a calendar fact rather than a guess.
   */
  const grant = scope.kind === "GRANTS" && scope.grants.length === 1 ? scope.grants[0]! : null;
  const campusYear = new Date().getUTCFullYear();

  return (
    <>
      <AdminPageHeader
        title="Add a student"
        back={{ href: "/admin/students", label: "All students" }}
        description={`The cohort must be inside your scope (${describeScope(scope)}).`}
      />
      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="p-5 lg:col-span-3">
          <AddStudentForm batchYear={grant?.batchYear ?? campusYear} departmentCode={grant?.departmentCode ?? null} />
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title="What this does" />
          <div className="space-y-3 px-5 pb-5 pt-3 text-sm text-text-secondary">
            <ul className="list-disc space-y-1.5 pl-5">
              <li>
                The same checks as a roster file, on one row: the fields are the CSV columns (
                <code className="font-mono text-xs">{ROSTER_COLUMNS.join(", ")}</code>).
              </li>
              <li>
                A roll number, email or LMS id that already belongs to an account is refused — open that student from
                the list instead of creating a second account for one person.
              </li>
              <li>The account has no password. The student sets one with the link on the sign-in page.</li>
              <li>It is recorded in the audit log with your name, the roll number and your scope.</li>
              <li>For a whole class, import the roster file — it is one upload and one review.</li>
            </ul>
          </div>
        </Card>
      </div>
    </>
  );
}
