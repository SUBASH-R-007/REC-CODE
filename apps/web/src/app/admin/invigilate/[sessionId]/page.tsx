import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { formatCampusTime } from "@recx/shared";
import { requireAdminScopePage } from "@/lib/auth/scope";
import { getHallView } from "@/server/queries/admin-invigilator";
import { AdminPageHeader } from "@/components/admin/admin-ui";
import { HallBoard } from "@/components/admin/invigilate/hall-board";

export const metadata: Metadata = { title: "Hall" };
export const dynamic = "force-dynamic";

/**
 * One hall, live (Phase 6e).
 *
 * The first frame is server-rendered so the screen is useful before any
 * JavaScript runs; the client then subscribes to
 * `/api/exam/sessions/[id]/live` and replaces it when something changes.
 *
 * Nothing on this page is a verdict. SPEC §5: "Show evidence chips, never a
 * guilt verdict, and never a student's photo next to a flag count." There is
 * no band, no points total and no photograph anywhere on it.
 */
export default async function HallPage({ params }: { params: Promise<{ sessionId: string }> }) {
  // The guard is the FIRST statement: a layout guard alone is not RBAC, and
  // capabilities.test.ts checks the order so a future edit cannot slip a
  // read in before it.
  await requireAdminScopePage();
  const { sessionId } = await params;

  const view = await getHallView(sessionId);
  if (!view) notFound();

  return (
    <div>
      <AdminPageHeader
        title={view.room ? `${view.label} · ${view.room}` : view.label}
        description={`${view.assessmentTitle} · ${formatCampusTime(view.startsAt)} to ${formatCampusTime(view.endsAt)}. Amber means a candidate's connection has dropped — check on them. It is never a finding against them.`}
      />
      <HallBoard
        initial={{
          sessionId: view.sessionId,
          label: view.label,
          room: view.room,
          assessmentTitle: view.assessmentTitle,
          candidates: view.candidates.map((candidate) => ({
            ...candidate,
            accommodationFlags: candidate.accommodationFlags,
          })),
          counts: view.counts,
          serverNow: view.serverNow.toISOString(),
        }}
      />
    </div>
  );
}
