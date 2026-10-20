import "server-only";

import { canFreeze } from "@recx/shared";
import type { ContestKind, ContestStatus, ContestVisibility } from "@recx/db";
import { db } from "@/lib/db";

/**
 * Staff reads for contest authoring (Phase 5). Staff see every contest,
 * drafts included — unlike students, whose queries hide a DRAFT and apply
 * the cohort audience (server/queries/contests.ts).
 */

export interface AdminContestRow {
  id: string;
  slug: string;
  title: string;
  kind: ContestKind;
  status: ContestStatus;
  visibility: ContestVisibility;
  startsAt: Date;
  endsAt: Date;
  isRated: boolean;
  problems: number;
  registrations: number;
}

export async function listAdminContests(): Promise<AdminContestRow[]> {
  const rows = await db.contest.findMany({
    orderBy: [{ startsAt: "desc" }],
    take: 100,
    select: {
      id: true,
      slug: true,
      title: true,
      kind: true,
      status: true,
      visibility: true,
      startsAt: true,
      endsAt: true,
      isRated: true,
      _count: { select: { problems: true, registrations: true } },
    },
  });
  return rows.map((c) => ({
    id: c.id,
    slug: c.slug,
    title: c.title,
    kind: c.kind,
    status: c.status,
    visibility: c.visibility,
    startsAt: c.startsAt,
    endsAt: c.endsAt,
    isRated: c.isRated,
    problems: c._count.problems,
    registrations: c._count.registrations,
  }));
}

export interface AdminContestDetail extends AdminContestRow {
  rules: string;
  freezeMinutes: number;
  freezes: boolean;
  audienceBatchYear: number | null;
  audienceDepartmentCode: string | null;
  ratingComputedAt: Date | null;
  ratedParticipants: number | null;
  standingsVersion: number;
  problemList: Array<{
    id: string;
    index: string;
    points: number;
    problemSlug: string;
    problemTitle: string;
    /** The PINNED revision — not whatever the problem is on now. */
    revision: number;
    /** True when the problem has since moved on, which this contest ignores. */
    supersededByLive: boolean;
  }>;
}

export async function getAdminContest(id: string): Promise<AdminContestDetail | null> {
  const contest = await db.contest.findUnique({
    where: { id },
    select: {
      id: true,
      slug: true,
      title: true,
      rules: true,
      kind: true,
      status: true,
      visibility: true,
      startsAt: true,
      endsAt: true,
      freezeMinutes: true,
      isRated: true,
      audienceBatchYear: true,
      audienceDepartmentCode: true,
      ratingComputedAt: true,
      ratedParticipants: true,
      standingsVersion: true,
      _count: { select: { problems: true, registrations: true } },
      problems: {
        orderBy: { index: "asc" },
        select: {
          id: true,
          index: true,
          points: true,
          problemVersionId: true,
          problemVersion: {
            select: {
              revision: true,
              title: true,
              problem: { select: { slug: true, liveVersionId: true } },
            },
          },
        },
      },
    },
  });
  if (!contest) return null;

  return {
    id: contest.id,
    slug: contest.slug,
    title: contest.title,
    rules: contest.rules,
    kind: contest.kind,
    status: contest.status,
    visibility: contest.visibility,
    startsAt: contest.startsAt,
    endsAt: contest.endsAt,
    freezeMinutes: contest.freezeMinutes,
    freezes: canFreeze({
      startsAt: contest.startsAt,
      endsAt: contest.endsAt,
      freezeMinutes: contest.freezeMinutes,
    }),
    isRated: contest.isRated,
    audienceBatchYear: contest.audienceBatchYear,
    audienceDepartmentCode: contest.audienceDepartmentCode,
    ratingComputedAt: contest.ratingComputedAt,
    ratedParticipants: contest.ratedParticipants,
    standingsVersion: contest.standingsVersion,
    problems: contest._count.problems,
    registrations: contest._count.registrations,
    problemList: contest.problems.map((p) => ({
      id: p.id,
      index: p.index,
      points: p.points,
      problemSlug: p.problemVersion.problem.slug,
      problemTitle: p.problemVersion.title,
      revision: p.problemVersion.revision,
      supersededByLive: p.problemVersion.problem.liveVersionId !== p.problemVersionId,
    })),
  };
}
