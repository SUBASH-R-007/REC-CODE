import { ICPC_PENALTY_MINUTES, type ContestKind } from "@recx/shared";
import type { ContestPhase } from "@/server/queries/contests";

/**
 * Presentation helpers for the contest pages. Pure, so the copy that states
 * the rules of a contest is unit-tested rather than hidden in JSX.
 */

export const KIND_LABEL: Readonly<Record<ContestKind, string>> = {
  ICPC: "ICPC",
  SUBTASK: "Subtask scoring",
};

export const KIND_DESCRIPTION: Readonly<Record<ContestKind, string>> = {
  ICPC: `One point per problem solved. Ties break on penalty: the minute you solved it, plus ${ICPC_PENALTY_MINUTES} minutes for each rejected submission on a problem you later solve. A rejected submission on a problem you never solve costs nothing.`,
  SUBTASK: "Partial credit: each problem awards its best score across your submissions. There is no time penalty.",
};

export const PHASE_LABEL: Readonly<Record<ContestPhase, string>> = {
  upcoming: "Upcoming",
  running: "Running",
  finished: "Finished",
};

export function phaseTone(phase: ContestPhase): "success" | "info" | "default" {
  if (phase === "running") return "success";
  if (phase === "upcoming") return "info";
  return "default";
}

/** "2 h", "1 h 30 m", "45 m" — a duration a student reads at a glance. */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} m`;
}

/** The contest clock: "1:23:45" counting down, or "0:00:00" once it is over. */
export function formatClock(msRemaining: number): string {
  const total = Math.max(0, Math.floor(msRemaining / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export interface RatedNotice {
  rated: boolean;
  text: string;
}

/**
 * What the landing page says about rating, BEFORE the contest starts — SPEC
 * §5: "a contest with fewer than 30 rated participants is automatically
 * unrated and says so in advance".
 */
export function ratedNotice(contest: {
  isRated: boolean;
  phase: ContestPhase;
  participants?: number;
  ratedParticipants: number | null;
}): RatedNotice {
  if (!contest.isRated) {
    return { rated: false, text: "Unrated. Your rating will not change." };
  }
  if (contest.ratedParticipants !== null) {
    return {
      rated: true,
      text: `Rated. ${contest.ratedParticipants} participants counted towards rating.`,
    };
  }
  return {
    rated: true,
    text: "Rated — but only if at least 30 students take part. With fewer, the contest becomes unrated and nobody's rating changes.",
  };
}

/** The freeze sentence, or null when this contest never freezes. */
export function freezeNotice(contest: { canFreeze: boolean; freezeMinutes: number }): string | null {
  if (!contest.canFreeze) return null;
  return `The standings freeze for the last ${contest.freezeMinutes} minutes. You will still see your own row.`;
}

/** The href of a contest problem inside the arena. */
export function arenaProblemHref(slug: string, index: string): string {
  return `/contests/${slug}/arena?p=${encodeURIComponent(index)}`;
}

export function contestHref(slug: string, page?: "arena" | "standings" | "analysis"): string {
  return page ? `/contests/${slug}/${page}` : `/contests/${slug}`;
}
