"use client";

import { PanelBottomOpen } from "lucide-react";
import { Button } from "@recx/design";
import type { JobKind } from "@recx/shared";
import { useWorkspace } from "@/components/workspace/workspace-context";

/** Opens a past result in the workspace console. Renders nothing outside a workspace. */
export function ShowResultButton({ kind, id, label }: { kind: JobKind; id: string; label: string }) {
  const workspace = useWorkspace();
  if (!workspace) return null;
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-8! w-8!"
      aria-label={label}
      title="Show in console"
      onClick={() => workspace.showResult({ kind, id })}
    >
      <PanelBottomOpen className="h-4 w-4" aria-hidden />
    </Button>
  );
}
