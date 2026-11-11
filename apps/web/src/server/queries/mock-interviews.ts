import "server-only";
import {
  MOCK_INTERVIEW_REFUSALS,
  endsAt,
  isJoinable,
  mayCancel,
  mayMarkNoShow,
  type MockInterviewStatus,
} from "@recx/shared";
import { db } from "@/lib/db";
import { renderMarkdown } from "@/lib/markdown";

/**
 * Reading mock interviews (Phase 12h).
 *
 * The mirror read is the one that matters. `mirrorFor` answers for the
 * interview's own MENTOR and only while it is IN_PROGRESS — the SSE route
 * re-asks it on every tick rather than deciding once at connect, so an
 * interview that ends, or is cancelled, closes the mirror on the next
 * poll instead of streaming a student's editor to a page nobody is sitting
 * at any more.
 */

const PERSON = { select: { firstName: true, lastName: true, handle: true } } as const;
const name = (p: { firstName: string; lastName: string }) => `${p.firstName} ${p.lastName}`.trim();

export interface MockSlotView {
  id: string;
  status: MockInterviewStatus;
  startsAt: Date;
  endsAt: Date;
  durationMinutes: number;
  mentor: string;
  candidate: string | null;
  problem: { slug: string; title: string; displayCode: string } | null;
  /** Both sides may be in the room now. */
  joinable: boolean;
  /** The candidate may still hand it back. */
  giveUpOpen: boolean;
  /** The interviewer may mark a no-show. */
  noShowOpen: boolean;
  cancelReason: string | null;
  cancelledBy: string | null;
  feedback: {
    communication: number;
    problemSolving: number;
    code: number;
    /** Sanitised HTML. */
    html: string;
    at: Date;
  } | null;
}

const SLOT_SELECT = {
  id: true,
  status: true,
  startsAt: true,
  durationMinutes: true,
  mentor: PERSON,
  candidate: PERSON,
  candidateId: true,
  mentorId: true,
  problem: { select: { slug: true, title: true, displayCode: true } },
  cancelReason: true,
  cancelledBy: PERSON,
  ratingCommunication: true,
  ratingProblemSolving: true,
  ratingCode: true,
  feedbackMd: true,
  feedbackAt: true,
} as const;

type SlotRow = {
  id: string;
  status: MockInterviewStatus;
  startsAt: Date;
  durationMinutes: number;
  mentor: { firstName: string; lastName: string; handle: string };
  candidate: { firstName: string; lastName: string; handle: string } | null;
  candidateId: string | null;
  mentorId: string;
  problem: { slug: string; title: string; displayCode: string } | null;
  cancelReason: string | null;
  cancelledBy: { firstName: string; lastName: string; handle: string } | null;
  ratingCommunication: number | null;
  ratingProblemSolving: number | null;
  ratingCode: number | null;
  feedbackMd: string | null;
  feedbackAt: Date | null;
};

function viewOf(row: SlotRow, now: Date): MockSlotView {
  const window = { startsAt: row.startsAt, durationMinutes: row.durationMinutes };
  return {
    id: row.id,
    status: row.status,
    startsAt: row.startsAt,
    endsAt: endsAt(window),
    durationMinutes: row.durationMinutes,
    mentor: name(row.mentor),
    candidate: row.candidate ? name(row.candidate) : null,
    problem: row.problem,
    joinable: (row.status === "BOOKED" || row.status === "IN_PROGRESS") && isJoinable(window, now),
    giveUpOpen: row.status === "BOOKED" && mayCancel(window, now),
    noShowOpen: row.status === "BOOKED" && mayMarkNoShow(window, now),
    cancelReason: row.cancelReason,
    cancelledBy: row.cancelledBy ? name(row.cancelledBy) : null,
    feedback:
      row.feedbackAt && row.feedbackMd && row.ratingCommunication && row.ratingProblemSolving && row.ratingCode
        ? {
            communication: row.ratingCommunication,
            problemSolving: row.ratingProblemSolving,
            code: row.ratingCode,
            html: renderMarkdown(row.feedbackMd),
            at: row.feedbackAt,
          }
        : null,
  };
}

export interface StudentMockView {
  mine: MockSlotView[];
  open: MockSlotView[];
  past: MockSlotView[];
}

export async function loadStudentMocks(userId: string, now: Date = new Date()): Promise<StudentMockView> {
  const [mine, open, past] = await Promise.all([
    db.mockInterview.findMany({
      where: { candidateId: userId, status: { in: ["BOOKED", "IN_PROGRESS"] } },
      orderBy: { startsAt: "asc" },
      select: SLOT_SELECT,
    }),
    db.mockInterview.findMany({
      where: { status: "OPEN", startsAt: { gte: now } },
      orderBy: { startsAt: "asc" },
      take: 30,
      select: SLOT_SELECT,
    }),
    db.mockInterview.findMany({
      where: { candidateId: userId, status: { in: ["COMPLETED", "CANCELLED", "NO_SHOW"] } },
      orderBy: { startsAt: "desc" },
      take: 20,
      select: SLOT_SELECT,
    }),
  ]);
  return {
    mine: mine.map((row) => viewOf(row, now)),
    open: open.map((row) => viewOf(row, now)),
    past: past.map((row) => viewOf(row, now)),
  };
}

export async function loadMentorMocks(mentorId: string, now: Date = new Date()): Promise<{ upcoming: MockSlotView[]; past: MockSlotView[] }> {
  const [upcoming, past] = await Promise.all([
    db.mockInterview.findMany({
      where: { mentorId, status: { in: ["OPEN", "BOOKED", "IN_PROGRESS"] } },
      orderBy: { startsAt: "asc" },
      select: SLOT_SELECT,
    }),
    db.mockInterview.findMany({
      where: { mentorId, status: { in: ["COMPLETED", "CANCELLED", "NO_SHOW"] } },
      orderBy: { startsAt: "desc" },
      take: 20,
      select: SLOT_SELECT,
    }),
  ]);
  return { upcoming: upcoming.map((row) => viewOf(row, now)), past: past.map((row) => viewOf(row, now)) };
}

/** One slot, for the session page, readable only by its two people. */
export async function loadMockSession(
  userId: string,
  interviewId: string,
  now: Date = new Date(),
): Promise<{ view: MockSlotView; role: "MENTOR" | "CANDIDATE" } | null> {
  const row = await db.mockInterview.findUnique({ where: { id: interviewId }, select: SLOT_SELECT });
  if (!row) return null;
  const role = row.mentorId === userId ? "MENTOR" : row.candidateId === userId ? "CANDIDATE" : null;
  if (!role) return null;
  return { view: viewOf(row, now), role };
}

// ── The mirror ──────────────────────────────────────────────────────────

export interface MirrorView {
  language: string;
  source: string;
  updatedAt: string;
  candidate: string;
  problem: { slug: string; title: string; displayCode: string } | null;
}

export type MirrorResult =
  | { ok: true; view: MirrorView }
  | { ok: false; status: number; error: string };

/**
 * The candidate's editor, for the interviewer.
 *
 * Two conditions, both re-checked on every poll rather than once at
 * connect: the viewer IS this interview's mentor, and the interview IS
 * running. An interview that ends while somebody is watching closes the
 * mirror on the next tick; a mentor who is not this one never opens it at
 * all.
 */
export async function mirrorFor(viewerId: string, interviewId: string): Promise<MirrorResult> {
  const row = await db.mockInterview.findUnique({
    where: { id: interviewId },
    select: {
      mentorId: true,
      status: true,
      candidate: PERSON,
      problem: { select: { slug: true, title: true, displayCode: true } },
      snapshot: { select: { language: true, source: true, updatedAt: true } },
    },
  });
  if (!row) return { ok: false, status: 404, error: "That interview was not found." };
  if (row.mentorId !== viewerId) return { ok: false, status: 403, error: MOCK_INTERVIEW_REFUSALS.notYours };
  if (row.status !== "IN_PROGRESS") return { ok: false, status: 409, error: MOCK_INTERVIEW_REFUSALS.notRunning };

  return {
    ok: true,
    view: {
      language: row.snapshot?.language ?? "",
      source: row.snapshot?.source ?? "",
      updatedAt: (row.snapshot?.updatedAt ?? new Date(0)).toISOString(),
      candidate: row.candidate ? name(row.candidate) : "the candidate",
      problem: row.problem,
    },
  };
}
