import "server-only";
import { db } from "@/lib/db";

/**
 * What the assessment admin reads (Phase 12a). Staff-only by construction:
 * every caller is a page behind `requireActionRole("ADMIN","SUPER_ADMIN")`'s
 * page equivalent, and nothing here is reachable from a student surface.
 */

export interface AssessmentRow {
  id: string;
  slug: string;
  title: string;
  status: string;
  proctorMode: string;
  affectsPlacementEligibility: boolean;
  opensAt: Date;
  closesAt: Date;
  durationSec: number;
  questions: number;
  halls: number;
  attempts: number;
}

export async function listAssessments(): Promise<AssessmentRow[]> {
  const rows = await db.assessment.findMany({
    orderBy: [{ opensAt: "desc" }],
    take: 200,
    select: {
      id: true,
      slug: true,
      title: true,
      status: true,
      proctorMode: true,
      affectsPlacementEligibility: true,
      opensAt: true,
      closesAt: true,
      durationSec: true,
      _count: { select: { problems: true, sessions: true, attempts: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    title: r.title,
    status: r.status,
    proctorMode: r.proctorMode,
    affectsPlacementEligibility: r.affectsPlacementEligibility,
    opensAt: r.opensAt,
    closesAt: r.closesAt,
    durationSec: r.durationSec,
    questions: r._count.problems,
    halls: r._count.sessions,
    attempts: r._count.attempts,
  }));
}

export interface AssessmentDetail extends AssessmentRow {
  instructions: string;
  maxAttempts: number;
  maxFocusWarnings: number;
  onLimit: string;
  strictMode: boolean;
  audienceBatchYear: number | null;
  audienceDepartmentCode: string | null;
  audienceSection: string | null;
  problems: Array<{
    id: string;
    position: number;
    points: number;
    slug: string;
    displayCode: string;
    title: string;
    revision: number;
  }>;
  sessions: Array<{
    id: string;
    label: string;
    room: string | null;
    startsAt: Date;
    endsAt: Date;
    capacity: number;
    allowedCidrs: string[];
    seated: number;
  }>;
}

export async function getAssessmentDetail(id: string): Promise<AssessmentDetail | null> {
  const row = await db.assessment.findUnique({
    where: { id },
    select: {
      id: true,
      slug: true,
      title: true,
      instructions: true,
      status: true,
      proctorMode: true,
      affectsPlacementEligibility: true,
      opensAt: true,
      closesAt: true,
      durationSec: true,
      maxAttempts: true,
      maxFocusWarnings: true,
      onLimit: true,
      strictMode: true,
      audienceBatchYear: true,
      audienceDepartmentCode: true,
      audienceSection: true,
      _count: { select: { problems: true, sessions: true, attempts: true } },
      problems: {
        orderBy: { position: "asc" },
        select: {
          id: true,
          position: true,
          points: true,
          problemVersion: {
            select: { revision: true, title: true, problem: { select: { slug: true, displayCode: true } } },
          },
        },
      },
      sessions: {
        orderBy: { startsAt: "asc" },
        select: {
          id: true,
          label: true,
          room: true,
          startsAt: true,
          endsAt: true,
          capacity: true,
          allowedCidrs: true,
          _count: { select: { attempts: true } },
        },
      },
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    instructions: row.instructions,
    status: row.status,
    proctorMode: row.proctorMode,
    affectsPlacementEligibility: row.affectsPlacementEligibility,
    opensAt: row.opensAt,
    closesAt: row.closesAt,
    durationSec: row.durationSec,
    maxAttempts: row.maxAttempts,
    maxFocusWarnings: row.maxFocusWarnings,
    onLimit: row.onLimit,
    strictMode: row.strictMode,
    audienceBatchYear: row.audienceBatchYear,
    audienceDepartmentCode: row.audienceDepartmentCode,
    audienceSection: row.audienceSection,
    questions: row._count.problems,
    halls: row._count.sessions,
    attempts: row._count.attempts,
    problems: row.problems.map((p) => ({
      id: p.id,
      position: p.position,
      points: p.points,
      slug: p.problemVersion.problem.slug,
      displayCode: p.problemVersion.problem.displayCode,
      title: p.problemVersion.title,
      revision: p.problemVersion.revision,
    })),
    sessions: row.sessions.map((s) => ({
      id: s.id,
      label: s.label,
      room: s.room,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      capacity: s.capacity,
      allowedCidrs: s.allowedCidrs,
      seated: s._count.attempts,
    })),
  };
}
