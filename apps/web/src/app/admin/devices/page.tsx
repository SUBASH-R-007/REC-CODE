import type { Metadata } from "next";
import { Smartphone } from "lucide-react";
import { EmptyState } from "@recx/design";
import { formatCampusTime } from "@recx/shared";
import { findScopedStudent, requireAdminScopePage } from "@/lib/auth/scope";
import { listStudentDevices } from "@/server/queries/admin-devices";
import { AdminPageHeader } from "@/components/admin/admin-ui";
import { DeviceEnrolment } from "@/components/exam/device-enrolment";
import { RevokeDeviceButton } from "@/components/admin/devices/revoke-device-button";

export const metadata: Metadata = { title: "Exam devices" };

type SearchParams = Promise<{ student?: string | string[] }>;

/**
 * `/admin/devices` — supervised exam-device enrolment (Phase 6d).
 *
 * SPEC §5 requires enrolment to be "supervised in-lab": the student touches
 * their own authenticator on THIS screen, with a supervisor present. That is
 * the whole security property, and it is why there is no student-facing
 * equivalent of this page.
 *
 * The student is looked up through the admin's `AdminScope`, so a
 * department's administrator sees and enrols for their own students only.
 * Reads go through `server/queries/admin-devices`, because an `/admin` page
 * may not import `@/lib/db` at all (`tests/repo/admin-scope.test.ts` R9) —
 * which means every staff-facing read of a student's data goes through a
 * function that takes a scope and cannot forget to apply it.
 */
export default async function AdminDevicesPage({ searchParams }: { searchParams: SearchParams }) {
  const { scope } = await requireAdminScopePage();
  const raw = (await searchParams).student;
  const collegeId = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";

  const student = collegeId
    ? await findScopedStudent(scope, { collegeId: { equals: collegeId, mode: "insensitive" } })
    : null;

  const devices = student ? await listStudentDevices(scope, student.scopedId) : [];

  return (
    <div>
      <AdminPageHeader
        title="Exam devices"
        description="Enrol the device a student will sit a proctored assessment on. They touch their own device on this screen, with you present — that is what stops someone sitting an exam for someone else. A single-use loaner takes thirty seconds and does not count towards a student's two-device limit."
      />

      <form method="get" className="mt-6 flex flex-wrap items-end gap-3">
        <label className="text-sm font-medium text-text">
          Student&apos;s college ID
          <input
            name="student"
            defaultValue={collegeId}
            placeholder="RECCSE2027001"
            className="mt-1 block w-64 rounded-md border border-border bg-surface px-3 py-2 text-sm text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
        </label>
        <button
          type="submit"
          className="rounded-md border border-border px-4 py-2 text-sm font-medium text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          Find student
        </button>
      </form>

      {collegeId && !student ? (
        <p className="mt-6 rounded-md border border-border px-3 py-2 text-sm text-text-secondary">
          {/*
            The same answer for an unknown ID and one outside this admin's
            scope, so one cannot be used to discover the other.
          */}
          That student was not found.
        </p>
      ) : null}

      {student ? (
        <div className="mt-6 flex flex-col gap-6">
          <DeviceEnrolment
            student={{
              id: student.scopedId,
              name: `${student.firstName} ${student.lastName}`.trim(),
              collegeId: student.collegeId,
            }}
          />

          <section>
            <h2 className="font-display text-lg font-semibold text-text">Registered devices</h2>
            {devices.length === 0 ? (
              <div className="mt-3">
                <EmptyState
                  icon={<Smartphone className="h-6 w-6" aria-hidden />}
                  title="No devices yet"
                  description="Enrol one above before this student sits a lab-supervised or remotely monitored assessment."
                />
              </div>
            ) : (
              <ul className="mt-3 flex flex-col gap-2">
                {devices.map((device) => {
                  const active = device.active;
                  return (
                    <li
                      key={device.id}
                      className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border bg-surface p-3"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-text">{device.label}</p>
                        <p className="mt-0.5 text-xs text-text-secondary">
                          Enrolled {formatCampusTime(device.enrolledAt)}
                          {device.isLoaner ? " · loaner" : ""}
                          {device.loanConsumedAt ? ` · used ${formatCampusTime(device.loanConsumedAt)}` : ""}
                          {device.revokedAt ? ` · withdrawn ${formatCampusTime(device.revokedAt)}` : ""}
                        </p>
                      </div>
                      <span
                        className={`rounded-full border px-2 py-0.5 text-xs ${
                          active
                            ? "border-success/40 bg-success-subtle text-success"
                            : "border-border text-text-secondary"
                        }`}
                      >
                        {active ? "Active" : device.revokedAt ? "Withdrawn" : "Used"}
                      </span>
                      {active ? <RevokeDeviceButton deviceId={device.id} label={device.label} /> : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}
