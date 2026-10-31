import "server-only";
import { AI_REFUSALS, type AiAskKind, type HelpContext } from "@recx/shared";
import { countAsksToday } from "@/lib/ai/ask";
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

  const askedToday = await countAsksToday(userId, state.now);
  const access = aiAllowed(state, runtime.setting, askedToday);
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
