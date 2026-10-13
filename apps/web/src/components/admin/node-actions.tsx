"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CirclePause, Play, ShieldAlert } from "lucide-react";
import { Button, useToast } from "@recx/design";
import type { JudgeNodeStatus } from "@recx/shared";
import { NODE_ACTIONS, planNodeTransition, type NodeAction } from "@/lib/judge/metrics";
import { setJudgeNodeStatus } from "@/server/actions/admin-judge";
import { ReasonDialog } from "@/components/admin/reason-dialog";

const COPY: Record<NodeAction, { button: string; title: string; confirm: string; describe: (id: string) => string }> = {
  drain: {
    button: "Drain",
    title: "Drain judge node",
    confirm: "Drain node",
    describe: (id) =>
      `${id} finishes the jobs it holds and takes no new ones. It stays DRAINING until an admin returns it to ONLINE.`,
  },
  quarantine: {
    button: "Quarantine",
    title: "Quarantine judge node",
    confirm: "Quarantine node",
    describe: (id) =>
      `${id} stops taking work at once. Use this when the host may be compromised or misjudging. Quarantine is a security event.`,
  },
  online: {
    button: "Return to ONLINE",
    title: "Return judge node to service",
    confirm: "Return to ONLINE",
    describe: (id) =>
      `${id} starts taking work again on its next heartbeat. If it is not heartbeating it stays OFFLINE until it does.`,
  },
};

const ICON: Record<NodeAction, React.ReactNode> = {
  drain: <CirclePause className="h-4 w-4" aria-hidden />,
  quarantine: <ShieldAlert className="h-4 w-4" aria-hidden />,
  online: <Play className="h-4 w-4" aria-hidden />,
};

/**
 * Drain / Quarantine / Return to ONLINE for one node. Only the actions that
 * make sense for the node's current state are offered; the server decides
 * again (src/lib/judge/metrics.ts planNodeTransition) and audits.
 */
export function NodeActions({
  nodeId,
  status,
  selfCheckOk,
  heartbeatStale,
}: {
  nodeId: string;
  status: JudgeNodeStatus;
  selfCheckOk: boolean | null;
  heartbeatStale: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [action, setAction] = useState<NodeAction | null>(null);

  // Offer an action whenever the status allows it; a failed precondition
  // (self-check, host hardening) is explained in the dialog or by the server.
  const available = NODE_ACTIONS.filter((a) => {
    const plan = planNodeTransition(status, a, { selfCheckOk: null, hostHardened: null, heartbeatStale });
    return plan.ok;
  });
  if (available.length === 0) return null;

  const copy = action ? COPY[action] : null;
  const blockedOnline =
    action === "online"
      ? planNodeTransition(status, "online", { selfCheckOk, hostHardened: null, heartbeatStale })
      : null;

  return (
    <div className="flex flex-wrap gap-2">
      {available.map((a) => (
        <Button
          key={a}
          size="sm"
          variant={a === "quarantine" ? "danger" : "outline"}
          onClick={() => setAction(a)}
          aria-label={`${COPY[a].button}: ${nodeId}`}
        >
          {ICON[a]}
          {COPY[a].button}
        </Button>
      ))}
      {copy && action && (
        <ReasonDialog
          open
          onClose={() => setAction(null)}
          title={copy.title}
          confirmLabel={copy.confirm}
          danger={action === "quarantine"}
          description={
            <>
              <p>{copy.describe(nodeId)}</p>
              {blockedOnline && !blockedOnline.ok ? <p className="mt-2 text-danger">{blockedOnline.reason}</p> : null}
            </>
          }
          onConfirm={async (reason) => {
            const result = await setJudgeNodeStatus({ nodeId, action, reason });
            if (result.ok) {
              toast(`${nodeId} is now ${result.data.status}.`, "success");
              router.refresh();
            }
            return result;
          }}
        />
      )}
    </div>
  );
}
