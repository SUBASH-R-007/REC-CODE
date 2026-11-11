import "server-only";
import { AI_REFUSALS, type AiAskKind, type HelpContext } from "@recx/shared";
import { countAsksToday, countCollegeAsksToday } from "@/lib/ai/ask";
import { aiUsable, getAiRuntime } from "@/lib/ai/settings";
import { db } from "@/lib/db";
import { aiAllowed, getHelpState } from "@/lib/help/access";
import { istDayStart } from "@/lib/judge/caps";
import { renderUntrustedMarkdown } from "@/lib/markdown";

/**
 * What the practice workspace needs to draw the AI helper, decided entirely
 * on the server.
 *
 * `null` means draw nothing at all: no panel, no greyed-out button, no "the
 * assistant is not available here". In a contest or an assessment a student
 * should not be shown a door they cannot open, and a disabled control is
 * still a door. Inside practice the panel is drawn and `refusal` explains a
 * lock the student can clear by working.
 */

export interface AiPanelAnswer {
  id: string;
  kind: AiAskKind;
  /** Sanitised HTML (no links). */
  html: string;
  askedAt: Date;
}

export interface AiPanelState {
  problemId: string;
  allowed: boolean;
  /** Why the button is locked, in the student's words; null when it is not. */
  refusal: string | null;
  remainingToday: number;
  dailyPerStudent: number;
  /** True when the next answer will make a later first solve ASSISTED. */
  marksAssisted: boolean;
  /** Today's answers for this problem, oldest first, so a reload does not lose them. */
  answers: AiPanelAnswer[];
}

/**
 * What the panel says about the allowance, and what it titles the lock
 * (Phase 15n).
 *
 * Two sentences that have to agree with each other. The college's ceiling
 * (Phase 15j) made them disagree: a student with seven questions left read
 * "7 questions left today, of 10" directly above a lock saying the
 * assistant was resting until tomorrow. Both were true and together they
 * were nonsense.
 *
 * Pure, and here rather than in the component, so that what a student is
 * told is a thing a test can hold.
 */
export function aiAllowanceLine(state: Pick<AiPanelState, "refusal" | "remainingToday" | "dailyPerStudent">): string {
  if (state.refusal === AI_REFUSALS.collegeLimit) {
    return state.remainingToday > 0
      ? `Your own ${state.remainingToday} question${state.remainingToday === 1 ? "" : "s"} for today are untouched — it is the college's allowance that has run out.`
      : "The college's allowance has run out for today.";
  }
  return `${state.remainingToday} question${state.remainingToday === 1 ? "" : "s"} left today, of ${state.dailyPerStudent}.`;
}

/**
 * The heading over a lock, which is not the same sentence as the lock.
 *
 * "Not yet" is right when a student can clear the lock by working. It is
 * wrong when nothing they do today will open it — their own allowance is
 * spent, or the college's — and worse when it is the college's, because it
 * invites them to keep trying something that is not about them at all.
 */
export function aiLockTitle(state: Pick<AiPanelState, "refusal" | "remainingToday">): string {
  if (state.refusal === AI_REFUSALS.collegeLimit) return "Resting until tomorrow";
  if (state.remainingToday === 0) return "That is today's lot";
  return "Not yet";
}

/**
 * Whether the lock is an allowance that has run out, rather than something
 * the student can clear by working (Phase 15n).
 *
 * It picks the icon, and the two cases read differently on purpose: a
 * spent allowance comes back tomorrow, and "not yet" comes back as soon as
 * they have had a go. Deriving it from "is there any refusal at all" would
 * put the spent-allowance icon over a student who simply has not started —
 * which is what the first draft of this did.
 */
export function aiAllowanceSpent(state: Pick<AiPanelState, "refusal" | "remainingToday">): boolean {
  return state.remainingToday === 0 || state.refusal === AI_REFUSALS.collegeLimit;
}

export async function getAiPanelState(
  userId: string,
  problemId: string,
  context: HelpContext,
): Promise<AiPanelState | null> {
  // Outside practice there is no assistant and no notice about one.
  if (context !== "PRACTICE") return null;

  const runtime = await getAiRuntime();
  // Switched off, or this deployment has no key: the feature is simply not
  // there. A student is not the right person to tell about a missing key.
  if (!aiUsable(runtime)) return null;

  const state = await getHelpState(userId, problemId, context);
  if (!state) return null;

  const [askedToday, askedTodayCollege] = await Promise.all([
    countAsksToday(userId, state.now),
    countCollegeAsksToday(state.now),
  ]);
  const access = aiAllowed(state, runtime.setting, askedToday, askedTodayCollege);
  const rows = await db.aiAssist.findMany({
    where: { userId, problemId: state.problemId, failed: false, askedAt: { gte: istDayStart(state.now) } },
    orderBy: { askedAt: "asc" },
    select: { id: true, kind: true, answer: true, askedAt: true },
  });

  return {
    problemId: state.problemId,
    allowed: access.allowed,
    refusal: access.allowed ? null : (access.reason ?? AI_REFUSALS.off),
    remainingToday: Math.max(0, runtime.setting.dailyPerStudent - askedToday),
    dailyPerStudent: runtime.setting.dailyPerStudent,
    marksAssisted: !state.solved,
    answers: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      html: renderUntrustedMarkdown(row.answer ?? ""),
      askedAt: row.askedAt,
    })),
  };
}
