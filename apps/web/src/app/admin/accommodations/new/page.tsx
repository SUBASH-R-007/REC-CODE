import type { Metadata } from "next";
import Link from "next/link";
import { Info, UsersRound } from "lucide-react";
import { ButtonLink, Card, EmptyState } from "@recx/design";
import { ACCOMMODATION_LIMITS, campusDay } from "@recx/shared";
import { requireAdminScopePage, requireScopedStudentPage } from "@/lib/auth/scope";
import { formatCohort } from "@/lib/admin/cohort";
import { studentAccommodationState } from "@/server/queries/admin-accommodations";
import { AdminPageHeader } from "@/components/admin/admin-ui";
import { AccommodationForm, type AccommodationFormInitial } from "@/components/admin/accommodations/accommodation-form";

export const metadata: Metadata = { title: "Request an accommodation" };

type SearchParams = Promise<{ student?: string | string[] }>;

const DAY_MS = 86_400_000;

/**
 * Request an accommodation for one in-scope student (?student=<id>). With an
 * approved one on file, the request is a change that replaces it when
 * approved, pre-filled with the current terms. An open request must be
 * decided or withdrawn first.
 */
export default async function NewAccommodationPage({ searchParams }: { searchParams: SearchParams }) {
  const { user, scope } = await requireAdminScopePage();
  const raw = (await searchParams).student;
  const studentId = Array.isArray(raw) ? raw[0] : raw;
  const back = { href: "/admin/accommodations", label: "Accommodations" };

  if (!studentId) {
    return (
      <>
        <AdminPageHeader title="Request an accommodation" back={back} />
        <Card>
          <EmptyState
            icon={<UsersRound className="h-6 w-6" />}
            title="Start from the student"
            description="Find the student, open their page and choose “Request an accommodation”."
            action={<ButtonLink href="/admin/students">Find a student</ButtonLink>}
          />
        </Card>
      </>
    );
  }

  const student = await requireScopedStudentPage(scope, studentId);
  const state = await studentAccommodationState(student);
  const name = `${student.firstName} ${student.lastName}`;
  const now = new Date();
  const minDate = campusDay(new Date(now.getTime() + DAY_MS));
  const maxDate = campusDay(new Date(now.getTime() + (ACCOMMODATION_LIMITS.maxValidityDays - 1) * DAY_MS));
  const header = (
    <AdminPageHeader
      title={state.approved ? `Change the accommodation of ${name}` : `Request an accommodation for ${name}`}
      back={back}
      description={`${student.collegeId} · ${formatCohort(student)}`}
    />
  );

  if (state.openRequestId) {
    return (
      <>
        {header}
        <Card>
          <EmptyState
            icon={<Info className="h-6 w-6" />}
            title="A request is already open"
            description="Decide or withdraw the open request before filing another."
            action={<ButtonLink href={`/admin/accommodations/${state.openRequestId}`}>Open the request</ButtonLink>}
          />
        </Card>
      </>
    );
  }

  const a = state.approved;
  const defaultUntil = campusDay(new Date(now.getTime() + 180 * DAY_MS));
  const initial: AccommodationFormInitial = a
    ? {
        kinds: a.kinds,
        exemptSignals: a.exemptSignals,
        extraTimePercent: a.extraTimePercent,
        extraTimeMinutes: a.extraTimeMinutes,
        allowBreaks: a.allowBreaks,
        breakMinutes: a.breakMinutes,
        fontScalePercent: a.fontScalePercent,
        allowScribe: a.allowScribe,
        highContrast: a.highContrast,
        validUntil: a.validUntil > now ? campusDay(a.validUntil) : defaultUntil,
      }
    : {
        kinds: [],
        exemptSignals: [],
        extraTimePercent: 0,
        extraTimeMinutes: 0,
        allowBreaks: false,
        breakMinutes: 0,
        fontScalePercent: 100,
        allowScribe: false,
        highContrast: false,
        validUntil: defaultUntil,
      };

  return (
    <>
      {header}
      {a ? (
        <p role="note" className="mb-4 flex items-start gap-2 rounded-xl border border-info/30 bg-info-subtle px-4 py-3 text-sm text-info">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            The current accommodation stays in force until this change is approved; then it is replaced.{" "}
            <Link href={`/admin/accommodations/${a.id}` as never} className="font-medium underline">
              View the current one
            </Link>
          </span>
        </p>
      ) : null}
      <Card className="p-5">
        <AccommodationForm
          userId={student.scopedId}
          studentName={name}
          supersedesId={a?.id ?? null}
          initial={initial}
          canApproveNow={user.role === "SUPER_ADMIN"}
          minDate={minDate}
          maxDate={maxDate}
        />
      </Card>
    </>
  );
}
