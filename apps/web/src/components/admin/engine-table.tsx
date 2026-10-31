import { JUDGE_ENGINES, SQL_DIALECT_LABEL, SQL_DIALECT, type JudgeEngine } from "@recx/shared";
import type { QueueDepth } from "@/lib/judge/metrics";
import type { AdminNodeRow } from "@/server/queries/admin-judge";

/**
 * The fleet by ENGINE (Phase 12k, slice 5).
 *
 * A lane's backlog is the sum of two queues now, and the answer to "why is
 * PRACTICE backed up" is almost always one engine rather than both: every
 * SQL node offline looks exactly like a load problem on the lane table and
 * exactly like itself here.
 *
 * Nodes and slots sit beside the backlog on purpose — a queue with work in
 * it and no node to take it is the one state that needs a person, and it
 * is only visible when both numbers are on the same row.
 */

const ENGINE_LABEL: Readonly<Record<JudgeEngine, string>> = {
  isolate: "isolate (programs)",
  postgres: `${SQL_DIALECT_LABEL[SQL_DIALECT]} (SQL)`,
};

export function EngineTable({
  nodes,
  depths,
}: {
  nodes: readonly AdminNodeRow[];
  depths: Record<JudgeEngine, QueueDepth> | null;
}) {
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">Judge nodes and queue depth, by judging engine</caption>
      <thead>
        <tr className="border-b border-border text-xs uppercase tracking-wide text-muted">
          <th scope="col" className="px-5 py-2 text-left font-medium">
            Engine
          </th>
          <th scope="col" className="px-3 py-2 text-right font-medium">
            Nodes online
          </th>
          <th scope="col" className="px-3 py-2 text-right font-medium">
            Slots busy
          </th>
          <th scope="col" className="px-3 py-2 text-right font-medium">
            Waiting
          </th>
          <th scope="col" className="px-5 py-2 text-right font-medium">
            Active
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {JUDGE_ENGINES.map((engine) => {
          const own = nodes.filter((n) => n.engine === engine);
          const online = own.filter((n) => n.status === "ONLINE" && !n.heartbeatStale);
          const depth = depths?.[engine] ?? null;
          const waiting = depth === null ? null : depth.waiting + depth.delayed;
          // Work with nobody to take it: the one state that needs a person.
          const stranded = online.length === 0 && (waiting ?? 0) > 0;
          return (
            <tr key={engine} className={stranded ? "bg-danger-subtle" : undefined}>
              <th scope="row" className="px-5 py-2 text-left font-medium text-text">
                {ENGINE_LABEL[engine]}
                {stranded && (
                  <span className="block text-xs font-normal text-danger">
                    Work is waiting and no node of this engine is online.
                  </span>
                )}
              </th>
              <td className="px-3 py-2 text-right tabular-nums">
                {online.length} / {own.length}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {online.reduce((s, n) => s + n.busySlots, 0)} / {online.reduce((s, n) => s + n.slots, 0)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{waiting === null ? "—" : waiting.toLocaleString("en-IN")}</td>
              <td className="px-5 py-2 text-right tabular-nums">
                {depth === null ? "—" : depth.active.toLocaleString("en-IN")}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
