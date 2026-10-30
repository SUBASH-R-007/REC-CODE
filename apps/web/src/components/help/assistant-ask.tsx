"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Bug, Compass } from "lucide-react";
import { Button, Dialog, useToast } from "@recx/design";
import { AI_ASK_LABEL, type AiAskKind } from "@recx/shared";
import { askAiHelper } from "@/server/actions/ai-helper";
import { HELP_PROSE } from "@/components/help/prose";

export interface AssistantAnswer {
  id: string;
  kind: AiAskKind;
  /** Sanitised on the server (renderUntrustedMarkdown): allow-listed tags, no links. */
  html: string;
}

const ICON: Record<AiAskKind, typeof Bug> = { MISTAKE: Bug, APPROACH: Compass };

/**
 * The two question buttons and the answers so far.
 *
 * The browser sends a problem id and which of the two questions was asked,
 * and nothing else: the server reads the student's own draft, so a forged
 * request cannot make the college pay to summarise an arbitrary document.
 *
 * When asking would make a later first solve ASSISTED, the consequence is
 * spelled out next to the buttons and confirmed in a dialog first — the same
 * shape as revealing a tier-3 hint, because it is the same consequence.
 */
export function AssistantAsk({
  problemId,
  marksAssisted,
  remainingToday,
  initialAnswers,
  readOnly = false,
}: {
  problemId: string;
  marksAssisted: boolean;
  remainingToday: number;
  initialAnswers: AssistantAnswer[];
  /** Show the answers already given, but no way to ask for another. */
  readOnly?: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const warningId = useId();
  const [answers, setAnswers] = useState<AssistantAnswer[]>(initialAnswers);
  const [confirming, setConfirming] = useState<AiAskKind | null>(null);
  const [pending, startTransition] = useTransition();
  const [asking, setAsking] = useState<AiAskKind | null>(null);
  const latestRef = useRef<HTMLDivElement>(null);
  const moveFocus = useRef(false);

  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    latestRef.current?.focus();
  }, [answers]);

  function ask(kind: AiAskKind) {
    setAsking(kind);
    startTransition(async () => {
      const result = await askAiHelper({ problemId, kind });
      setConfirming(null);
      setAsking(null);
      if (!result.ok) {
        toast(result.error, "error");
        router.refresh();
        return;
      }
      moveFocus.current = true;
      setAnswers((previous) => [...previous, { id: `${kind}-${previous.length}`, kind, html: result.data.html }]);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {answers.length > 0 && (
        <ol className="space-y-3">
          {answers.map((answer, index) => {
            const Icon = ICON[answer.kind];
            return (
              <li key={answer.id} className="rounded-2xl border border-border bg-surface p-4">
                <h3 className="flex items-center gap-2 font-display text-sm font-semibold">
                  <Icon className="h-4 w-4 text-primary" aria-hidden />
                  {AI_ASK_LABEL[answer.kind]}
                </h3>
                <div
                  ref={index === answers.length - 1 ? latestRef : undefined}
                  tabIndex={-1}
                  className={`${HELP_PROSE} mt-3 outline-none`}
                  // Sanitised on the server — allow-listed tags, and no links.
                  dangerouslySetInnerHTML={{ __html: answer.html }}
                />
              </li>
            );
          })}
        </ol>
      )}

      {!readOnly && (
        <>
          {marksAssisted && (
            <p id={warningId} className="flex items-start gap-2 text-sm text-text">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
              <span>
                <span className="font-semibold">Heads up: </span>
                Asking makes your first solve of this problem count as assisted. It still counts as solved and still
                pays XP, at the assisted rate.
              </span>
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {(["MISTAKE", "APPROACH"] as const).map((kind) => {
              const Icon = ICON[kind];
              return (
                <Button
                  key={kind}
                  variant="outline"
                  className="min-h-11"
                  loading={pending && asking === kind && confirming === null}
                  disabled={pending || remainingToday === 0}
                  aria-describedby={marksAssisted ? warningId : undefined}
                  aria-haspopup={marksAssisted ? "dialog" : undefined}
                  onClick={() => (marksAssisted ? setConfirming(kind) : ask(kind))}
                >
                  <Icon className="h-4 w-4" aria-hidden />
                  {AI_ASK_LABEL[kind]}
                </Button>
              );
            })}
          </div>
        </>
      )}

      {confirming !== null && (
        <Dialog open onClose={() => setConfirming(null)} title="Ask the assistant?" size="sm">
          <p className="text-sm text-text-secondary">
            Your first solve of this problem will count as assisted. It still counts as solved, and still pays XP at
            the assisted rate — it just will not count towards the unassisted part of your readiness.
          </p>
          <p className="mt-2 text-sm text-text-secondary">
            Your problem statement and the draft in the editor are sent to the college&apos;s configured model.
          </p>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button variant="ghost" className="min-h-11" disabled={pending} onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button className="min-h-11" loading={pending} onClick={() => ask(confirming)}>
              {AI_ASK_LABEL[confirming]}
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
