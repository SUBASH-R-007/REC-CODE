import type { Metadata } from "next";
import Link from "next/link";
import { Accessibility } from "lucide-react";
import type { AccommodationStatus } from "@recx/db";
import { Card, EmptyState, cn } from "@recx/design";
import { requireAdminScopePage } from "@/lib/auth/scope";
import { listAccommodations } from "@/server/queries/admin-accommodations";
import { AdminPageHeader } from "@/components/admin/admin-ui";
import { ACCOMMODATION_STATUS, AccommodationList } from "@/components/admin/accommodations/accommodation-list";

export const metadata: Metadata = { title: "Accommodations" };

type SearchParams = Promise<{ status?: string | string[] }>;

const FILTERS: (AccommodationStatus | null)[] = [null, "REQUESTED", "APPROVED", "REJECTED", "WITHDRAWN", "REVOKED", "SUPERSEDED"];

function parseStatus(raw: string | string[] | undefined): AccommodationStatus | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return FILTERS.includes(v as AccommodationStatus) ? (v as AccommodationStatus) : null;
}

/**
 * Exam accommodations of the viewer's students. An administrator requests;
 * only a super-admin approves, rejects or revokes. The list shows terms and
 * validity only — the accommodation kinds and the reason are on each
 * accommodation's own page.
 */
export default async function AdminAccommodationsPage({ searchParams }: { searchParams: SearchParams }) {
  const { scope } = await requireAdminScopePage();
  const status = parseStatus((await searchParams).status);
  const rows = await listAccommodations(scope, status);
  const now = new Date();

  return (
    <>
      <AdminPageHeader
        title="Accommodations"
        description="Request one from a student's page. A super-admin approves it, with an end date; approved terms never change — a change is a new request that replaces them."
      />
      <nav aria-label="Filter by status" className="mb-4">
        <ul className="flex flex-wrap gap-2">
          {FILTERS.map((f) => {
            const active = f === status;
            return (
              <li key={f ?? "all"}>
                <Link
                  href={(f ? `/admin/accommodations?status=${f}` : "/admin/accommodations") as never}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "inline-flex min-h-9 items-center rounded-full border px-3 text-sm",
                    active ? "border-primary bg-primary-subtle font-semibold text-text" : "border-border text-text-secondary hover:text-text",
                  )}
                >
                  {f ? ACCOMMODATION_STATUS[f].label : "All"}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState
            icon={<Accessibility className="h-6 w-6" />}
            title="No accommodations here"
            description="Open a student's page and choose “Request an accommodation”."
          />
        ) : (
          <div className="pb-4 pt-3">
            <AccommodationList rows={rows} now={now} />
          </div>
        )}
      </Card>
    </>
  );
}
