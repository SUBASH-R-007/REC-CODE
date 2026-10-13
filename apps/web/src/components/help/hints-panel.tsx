import { Eye, Lightbulb, Lock, LockOpen } from "lucide-react";
import { Badge, EmptyState } from "@recx/design";
import type { HelpContext } from "@recx/shared";
import { requireUser } from "@/lib/auth/guards";
import { WORKSPACE_HELP_CONTEXT } from "@/lib/help/access";
import { loadHintsPanel, type HintRowView } from "@/lib/help/panels";
import { HelpReveal } from "@/components/help/help-reveal";

/**
 * The workspace's Hints tab (server component). Tiers 1–3 of the problem's
 * live version with their locked / unlocked / revealed state; what is
 * unlocked and what may be shown comes only from the help chokepoint
 * (src/lib/help/access.ts). Locked hint text never reaches the browser.
 *
 * Usage (workspace page): <HintsPanel problemId={problem.id} versionId={problem.versionId} />
 */
export async function HintsPanel({
  problemId,
  versionId,
  context = WORKSPACE_HELP_CONTEXT,
}: {
  problemId: string;
  versionId: string;
  /** Decided on the server by the page; the practice workspace is PRACTICE. */
  context?: HelpContext;
}) {
  const user = await requireUser();
  const view = await loadHintsPanel(user.id, problemId, versionId, context);

  return (
    <section aria-labelledby="help-hints-heading" className="space-y-4">
      <h2 id="help-hints-heading" className="font-display text-base font-semibold">
        Hints
      </h2>

      {view.kind === "ready" ? (
        <>
          <div className="space-y-1 text-sm text-text-secondary">
            <p>
              Hint 1 is open from the start. Later hints unlock after failed submissions or minutes of active work on
              this problem.
            </p>
            <p>{view.progress}</p>
          </div>
          <ol className="space-y-3">
            {view.rows.map((row) => (
              <li key={row.tier} className="rounded-2xl border border-border bg-surface p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-display text-sm font-semibold">Hint {row.tier}</h3>
                  <TierStatus row={row} />
                </div>
                <div className="mt-3">
                  {row.state === "locked" ? (
                    <p className="text-sm text-text-secondary">{row.condition}</p>
                  ) : (
                    <HelpReveal
                      target={{ kind: "hint", problemId, tier: row.tier }}
                      label={`Reveal hint ${row.tier}`}
                      warning={row.state === "available" ? row.warning : null}
                      initialHtml={row.state === "revealed" ? row.html : null}
                    />
                  )}
                </div>
              </li>
            ))}
          </ol>
        </>
      ) : view.kind === "empty" ? (
        <EmptyState
          compact
          icon={<Lightbulb className="h-5 w-5" />}
          title="No hints for this problem"
          description="This problem was published without hints."
        />
      ) : view.kind === "stale" ? (
        <EmptyState compact title="This problem was updated" description={view.message} />
      ) : (
        <EmptyState compact icon={<Lock className="h-5 w-5" />} title="Hints are not available" description={view.message} />
      )}
    </section>
  );
}

/** Icon + word: the state never relies on colour alone. */
function TierStatus({ row }: { row: HintRowView }) {
  if (row.state === "locked") {
    return (
      <Badge>
        <Lock className="h-3 w-3" aria-hidden />
        Locked
      </Badge>
    );
  }
  if (row.state === "available") {
    return (
      <Badge tone="primary">
        <LockOpen className="h-3 w-3" aria-hidden />
        Unlocked
      </Badge>
    );
  }
  return (
    <Badge tone="success">
      <Eye className="h-3 w-3" aria-hidden />
      Revealed
    </Badge>
  );
}
