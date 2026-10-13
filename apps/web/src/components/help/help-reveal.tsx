"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, BookOpen, Lightbulb } from "lucide-react";
import { Button, Dialog, useToast } from "@recx/design";
import type { HintTier } from "@/lib/help/schema";
import { revealHint, viewEditorial } from "@/server/actions/help";
import { HELP_PROSE } from "@/components/help/prose";

export type HelpTarget = { kind: "hint"; problemId: string; tier: HintTier } | { kind: "editorial"; problemId: string };

/**
 * One hint tier's or the editorial's content slot: the reveal button until
 * the student asks, then the content. The server decides everything — this
 * leaf only calls revealHint / viewEditorial (which ask the help chokepoint
 * again) and shows the sanitised HTML they return.
 *
 * When revealing makes a later solve ASSISTED the warning is shown next to
 * the button and confirmed in a dialog first. After a reveal, focus moves to
 * the content and the page refreshes so the server-rendered panel agrees;
 * the same component instance then receives the content as `initialHtml`,
 * so focus is not lost.
 */
export function HelpReveal({
  target,
  label,
  warning,
  initialHtml,
}: {
  target: HelpTarget;
  /** Button text, e.g. "Reveal hint 2" or "View editorial". */
  label: string;
  /** Assisted-solve warning, or null when revealing has no consequence. */
  warning: string | null;
  /** Server-rendered content when already revealed. */
  initialHtml: string | null;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [html, setHtml] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  const contentRef = useRef<HTMLDivElement>(null);
  const moveFocus = useRef(false);
  const warningId = useId();

  const shown = html ?? initialHtml;

  useEffect(() => {
    if (shown === null || !moveFocus.current) return;
    moveFocus.current = false;
    contentRef.current?.focus();
  }, [shown]);

  function reveal() {
    startTransition(async () => {
      const result =
        target.kind === "hint"
          ? await revealHint({ problemId: target.problemId, tier: target.tier })
          : await viewEditorial({ problemId: target.problemId });
      setConfirming(false);
      if (!result.ok) {
        toast(result.error, "error");
        return;
      }
      moveFocus.current = true;
      setHtml(result.data.html);
      router.refresh();
    });
  }

  if (shown !== null) {
    return (
      <div
        ref={contentRef}
        tabIndex={-1}
        className={`${HELP_PROSE} rounded-lg`}
        // Sanitised on the server by renderMarkdown() — allow-listed tags only.
        dangerouslySetInnerHTML={{ __html: shown }}
      />
    );
  }

  const Icon = target.kind === "hint" ? Lightbulb : BookOpen;
  return (
    <div className="space-y-3">
      {warning && (
        <p id={warningId} className="flex items-start gap-2 text-sm text-text">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
          <span>
            <span className="font-semibold">Heads up: </span>
            {warning}
          </span>
        </p>
      )}
      <Button
        variant="outline"
        className="min-h-11"
        loading={pending && !confirming}
        aria-describedby={warning ? warningId : undefined}
        aria-haspopup={warning ? "dialog" : undefined}
        onClick={() => (warning ? setConfirming(true) : reveal())}
      >
        {!(pending && !confirming) && <Icon className="h-4 w-4" aria-hidden />}
        {label}
      </Button>
      {warning && (
        <Dialog
          open={confirming}
          onClose={() => setConfirming(false)}
          title={target.kind === "hint" ? `Reveal hint ${target.tier}?` : "View the editorial?"}
          size="sm"
        >
          <p className="text-sm text-text-secondary">{warning}</p>
          <p className="mt-2 text-sm text-text-secondary">The problem still counts as solved when you get it accepted.</p>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button variant="ghost" className="min-h-11" disabled={pending} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button className="min-h-11" loading={pending} onClick={reveal}>
              {label}
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
