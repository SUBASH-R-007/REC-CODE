"use client";

import { createContext, createElement, useContext, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@recx/design";
import type { ActionResult } from "@/lib/errors";

/**
 * Shared client plumbing for the authoring forms: run a server action in a
 * transition, surface its error (inline and as a toast), and refresh the
 * server page on success so every section re-renders from the database.
 */
export function useActionRunner() {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run<T>(
    fn: () => Promise<ActionResult<T>>,
    options: { success?: string | ((data: T) => string); onSuccess?: (data: T) => void; refresh?: boolean } = {},
  ): void {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error);
        toast(result.error, "error");
        return;
      }
      if (options.success) toast(typeof options.success === "function" ? options.success(result.data) : options.success, "success");
      options.onSuccess?.(result.data);
      if (options.refresh !== false) router.refresh();
    });
  }

  return { run, pending, error, setError };
}

interface DraftSeq {
  versionId: string;
  editSeq: number;
  setEditSeq: (seq: number) => void;
}

const DraftSeqContext = createContext<DraftSeq | null>(null);

/**
 * The editSeq every draft form sends (optimistic concurrency). It starts
 * from the server-rendered value and moves forward with each successful
 * edit, so two quick saves from different sections do not conflict with
 * each other — only with somebody else's edit.
 */
export function DraftSeqProvider({ versionId, editSeq, children }: { versionId: string; editSeq: number; children: React.ReactNode }) {
  const [seq, setSeq] = useState(editSeq);
  useEffect(() => {
    setSeq((current) => Math.max(current, editSeq));
  }, [editSeq]);
  return createElement(
    DraftSeqContext.Provider,
    { value: { versionId, editSeq: seq, setEditSeq: (next: number) => setSeq((current) => Math.max(current, next)) } },
    children,
  );
}

export function useDraftSeq(): DraftSeq {
  const value = useContext(DraftSeqContext);
  if (!value) throw new Error("useDraftSeq needs a DraftSeqProvider.");
  return value;
}
