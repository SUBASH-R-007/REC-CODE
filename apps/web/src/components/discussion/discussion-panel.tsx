import { Lock, MessagesSquare } from "lucide-react";
import { EmptyState } from "@recx/design";
import type { HelpContext } from "@recx/shared";
import { requireUser } from "@/lib/auth/guards";
import { WORKSPACE_HELP_CONTEXT } from "@/lib/help/access";
import { loadDiscussionPanel } from "@/server/queries/discussion";
import { DiscussionBoard } from "@/components/discussion/discussion-board";

/**
 * The workspace's Discussion tab (server component, Phase 12d).
 *
 * Two lists with different rules, and the page says which is which:
 *
 *   * **Doubts** are open to everybody. Being stuck is the reason to ask,
 *     so gating them would gate the thing the gate exists to help. Only the
 *     student who asked and a TA or mentor may reply, which is what stops
 *     the doubt list becoming the solution list by the back door.
 *   * **Solutions and tips** need a solve to read and an UNASSISTED solve
 *     to post. Everything about that is decided by the help chokepoint
 *     (`discussionAllowed`), and when it says no the posts are never loaded
 *     at all rather than loaded and filtered.
 */
export async function DiscussionPanel({
  problemId,
  context = WORKSPACE_HELP_CONTEXT,
}: {
  problemId: string;
  /** Decided on the server by the page; the practice workspace is PRACTICE. */
  context?: HelpContext;
}) {
  const user = await requireUser();
  const panel = await loadDiscussionPanel(user, problemId, context);

  if (!panel) {
    return (
      <section aria-labelledby="discussion-heading" className="space-y-4">
        <h2 id="discussion-heading" className="font-display text-base font-semibold">
          Discussion
        </h2>
        <EmptyState
          compact
          icon={<Lock className="h-5 w-5" />}
          title="No discussion here"
          description="The discussion is for published practice problems."
        />
      </section>
    );
  }

  return (
    <section aria-labelledby="discussion-heading" className="space-y-6">
      <div>
        <h2 id="discussion-heading" className="font-display text-base font-semibold">
          Discussion
        </h2>
        <p className="mt-1 text-sm text-text-secondary">
          Ask a question whenever you are stuck. Solutions and tips open once you have solved it, so nothing here
          spoils the problem before you have had a go.
        </p>
      </div>

      {panel.posts.length === 0 && panel.doubts.length === 0 && !panel.access.mayPost && !panel.access.mayRead ? (
        <EmptyState
          compact
          icon={<MessagesSquare className="h-5 w-5" />}
          title="Nothing here yet"
          description={panel.access.readReason ?? ""}
        />
      ) : null}

      <DiscussionBoard panel={panel} />
    </section>
  );
}
