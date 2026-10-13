import { BookOpen, Lock } from "lucide-react";
import { EmptyState } from "@recx/design";
import type { HelpContext } from "@recx/shared";
import { requireUser } from "@/lib/auth/guards";
import { WORKSPACE_HELP_CONTEXT } from "@/lib/help/access";
import { loadEditorialPanel } from "@/lib/help/panels";
import { HelpReveal } from "@/components/help/help-reveal";

/**
 * The workspace's Editorial tab (server component). Locked — with the reason
 * and the student's progress — or an explicit "View editorial" step that
 * records the first view (EditorialView) before showing anything. Viewing
 * before solving makes a later solve ASSISTED, so that is said up front and
 * confirmed. The decision comes only from the help chokepoint.
 *
 * Usage (workspace page): <EditorialPanel problemId={problem.id} versionId={problem.versionId} />
 */
export async function EditorialPanel({
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
  const view = await loadEditorialPanel(user.id, problemId, versionId, context);

  return (
    <section aria-labelledby="help-editorial-heading" className="space-y-4">
      <h2 id="help-editorial-heading" className="font-display text-base font-semibold">
        Editorial
      </h2>

      {view.kind === "available" || view.kind === "viewed" ? (
        <HelpReveal
          target={{ kind: "editorial", problemId }}
          label="View editorial"
          warning={view.kind === "available" ? view.warning : null}
          initialHtml={view.kind === "viewed" ? view.html : null}
        />
      ) : view.kind === "locked" ? (
        <div className="flex items-start gap-3 rounded-2xl border border-border bg-surface p-4">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
          <div className="space-y-1">
            <p className="text-sm font-semibold">Locked</p>
            <p className="text-sm text-text-secondary">{view.reason}</p>
          </div>
        </div>
      ) : view.kind === "empty" ? (
        <EmptyState
          compact
          icon={<BookOpen className="h-5 w-5" />}
          title="No editorial yet"
          description="This problem does not have an editorial."
        />
      ) : view.kind === "stale" ? (
        <EmptyState compact title="This problem was updated" description={view.message} />
      ) : (
        <EmptyState
          compact
          icon={<Lock className="h-5 w-5" />}
          title="The editorial is not available"
          description={view.message}
        />
      )}
    </section>
  );
}
