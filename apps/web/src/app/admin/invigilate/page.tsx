import type { Metadata } from "next";
import Link from "next/link";
import { Eye } from "lucide-react";
import { EmptyState } from "@recx/design";
import { formatCampusTime } from "@recx/shared";
import { requireAdminScopePage } from "@/lib/auth/scope";
import { listLiveHalls } from "@/server/queries/admin-invigilator";
import { AdminPageHeader } from "@/components/admin/admin-ui";

export const metadata: Metadata = { title: "Invigilate" };
export const dynamic = "force-dynamic";

/**
 * `/admin/invigilate` — the halls an invigilator can open (Phase 6e).
 *
 * Deliberately a short list of halls rather than a list of candidates: an
 * invigilator supervises a room, and a screen that opens on 5,000 names is a
 * screen nobody uses.
 */
export default async function InvigilateIndexPage() {
  await requireAdminScopePage();
  const halls = await listLiveHalls();

  return (
    <div>
      <AdminPageHeader
        title="Invigilate"
        description="Halls sitting now, or within the next day. Open one to see presence, clocks and what has been recorded — and to message a candidate, grant time, or end a sitting with a colleague's confirmation."
      />

      {halls.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon={<Eye className="h-6 w-6" aria-hidden />}
            title="No halls scheduled"
            description="An exam session has to be scheduled against an assessment before candidates can be seated in it."
          />
        </div>
      ) : (
        <ul className="mt-6 flex flex-col gap-2">
          {halls.map((hall) => (
            <li key={hall.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-border bg-surface p-4">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-text">
                  {hall.label}
                  {hall.room ? ` · ${hall.room}` : ""}
                </p>
                <p className="mt-0.5 text-xs text-text-secondary">
                  {hall.assessmentTitle} · {formatCampusTime(hall.startsAt)} to {formatCampusTime(hall.endsAt)}
                </p>
              </div>
              <span className="text-xs text-text-secondary tabular-nums">
                {hall.candidates} {hall.candidates === 1 ? "candidate" : "candidates"}
              </span>
              <Link
                href={`/admin/invigilate/${hall.id}`}
                className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                Open
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
