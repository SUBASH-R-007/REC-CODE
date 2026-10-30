import { Lock, Sparkles } from "lucide-react";
import { EmptyState } from "@recx/design";
import type { HelpContext } from "@recx/shared";
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
            icon={state.remainingToday === 0 ? <Sparkles className="h-5 w-5" /> : <Lock className="h-5 w-5" />}
            title={state.remainingToday === 0 ? "That is today's lot" : "Not yet"}
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
