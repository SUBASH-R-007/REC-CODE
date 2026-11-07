import { Lock, Sparkles } from "lucide-react";
import { EmptyState } from "@recx/design";
import { AI_REFUSALS, type HelpContext } from "@recx/shared";
import { getAiPanelState } from "@/lib/ai/panel";
import { requireUser } from "@/lib/auth/guards";
import { WORKSPACE_HELP_CONTEXT } from "@/lib/help/access";
import { AssistantAsk } from "@/components/help/assistant-ask";

/**
 * The workspace's Assistant tab (server component).
 *
 * Returns null — no tab, no notice, nothing — whenever the assistant is not
 * a thing this student can use here: outside practice, with the helper
 * switched off, or on a deployment with no key. Inside practice the panel is
 * drawn and says what would unlock the button.
 *
 * Nothing about what the model is told is decided in the browser: this
 * component sends a problem id and a question kind, and the server reads the
 * student's own draft itself.
 */
/**
 * The heading over a lock, which is not the same sentence as the lock
 * itself (Phase 15j).
 *
 * "Not yet" is right when the student has work to do before the button
 * opens. It is wrong when nothing they can do will open it today — their
 * own allowance is spent, or the college's is — and worse when it is the
 * college's, because "not yet" invites them to keep trying something that
 * is not about them at all.
 */
function lockTitle(refusal: string | null, remainingToday: number): string {
  if (refusal === AI_REFUSALS.collegeLimit) return "Resting until tomorrow";
  if (remainingToday === 0) return "That is today's lot";
  return "Not yet";
}

export async function AssistantPanel({
  problemId,
  context = WORKSPACE_HELP_CONTEXT,
}: {
  problemId: string;
  /** Decided on the server by the page; the practice workspace is PRACTICE. */
  context?: HelpContext;
}) {
  const user = await requireUser();
  const state = await getAiPanelState(user.id, problemId, context);
  if (!state) {
    // The page decides whether this tab exists at all, so reaching here means
    // the problem itself is not one the assistant can be asked about. Say so
    // rather than render an empty tab.
    return (
      <section aria-labelledby="help-assistant-heading" className="space-y-4">
        <h2 id="help-assistant-heading" className="font-display text-base font-semibold">
          Assistant
        </h2>
        <EmptyState
          compact
          icon={<Lock className="h-5 w-5" />}
          title="The assistant is not available here"
          description="It answers on published practice problems only — never in a contest or an assessment."
        />
      </section>
    );
  }

  const spent = state.remainingToday === 0 || state.refusal === AI_REFUSALS.collegeLimit;

  return (
    <section aria-labelledby="help-assistant-heading" className="space-y-4">
      <h2 id="help-assistant-heading" className="font-display text-base font-semibold">
        Assistant
      </h2>
      <div className="space-y-1 text-sm text-text-secondary">
        <p>
          Stuck? Ask what is wrong with your code, or how to approach the problem. You get an explanation, never a
          finished solution — and it reads the code you have in the editor right now, so save a draft first.
        </p>
        <p>
          {state.remainingToday} question{state.remainingToday === 1 ? "" : "s"} left today, of {state.dailyPerStudent}.
        </p>
      </div>

      {state.allowed ? (
        <AssistantAsk
          problemId={state.problemId}
          marksAssisted={state.marksAssisted}
          remainingToday={state.remainingToday}
          initialAnswers={state.answers.map((a) => ({ id: a.id, kind: a.kind, html: a.html }))}
        />
      ) : (
        <>
          <EmptyState
            compact
            icon={spent ? <Sparkles className="h-5 w-5" /> : <Lock className="h-5 w-5" />}
            title={lockTitle(state.refusal, state.remainingToday)}
            description={state.refusal ?? ""}
          />
          {state.answers.length > 0 ? (
            <AssistantAsk
              problemId={state.problemId}
              marksAssisted={state.marksAssisted}
              remainingToday={0}
              initialAnswers={state.answers.map((a) => ({ id: a.id, kind: a.kind, html: a.html }))}
              readOnly
            />
          ) : null}
        </>
      )}
    </section>
  );
}
