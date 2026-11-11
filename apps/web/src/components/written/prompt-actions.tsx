"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Archive, Send } from "lucide-react";
import { Button, useToast } from "@recx/design";
import type { WrittenPromptStatus } from "@recx/shared";
import { publishWrittenPrompt, retireWrittenPrompt } from "@/server/actions/written";

/**
 * Publish or retire a question (Phase 12i).
 *
 * Retiring is not deleting, and the label says so: the question leaves
 * the list and every answer written against it stays readable by whoever
 * wrote it.
 */
export function PromptActions({ promptId, status }: { promptId: string; status: WrittenPromptStatus }) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();

  const run = (what: Promise<{ ok: boolean; error?: string }>, done: string) =>
    startTransition(async () => {
      const result = await what;
      toast(result.ok ? done : (result.error ?? "That did not work."), result.ok ? "success" : "error");
      if (result.ok) router.refresh();
    });

  if (status === "RETIRED") return null;

  return (
    <div className="flex flex-wrap gap-2">
      {status === "DRAFT" ? (
        <Button
          size="sm"
          className="min-h-11"
          loading={pending}
          onClick={() => run(publishWrittenPrompt({ promptId }), "Open. Students can answer it now.")}
        >
          <Send className="h-4 w-4" aria-hidden />
          Publish it
        </Button>
      ) : null}
      <Button
        size="sm"
        variant="outline"
        className="min-h-11"
        loading={pending}
        onClick={() =>
          run(retireWrittenPrompt({ promptId }), "Retired. Answers already written against it are kept.")
        }
      >
        <Archive className="h-4 w-4" aria-hidden />
        Retire it
      </Button>
    </div>
  );
}
