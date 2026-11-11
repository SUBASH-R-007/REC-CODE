"use client";

import { createContext, useContext } from "react";
import type { JudgeTarget } from "@/hooks/use-verdict-stream";

/**
 * Lets server-rendered parts of the workspace (the submissions history) ask
 * the client workspace to show a result in its console.
 */
export interface WorkspaceActions {
  showResult: (target: JudgeTarget) => void;
}

export const WorkspaceContext = createContext<WorkspaceActions | null>(null);

export function useWorkspace(): WorkspaceActions | null {
  return useContext(WorkspaceContext);
}
