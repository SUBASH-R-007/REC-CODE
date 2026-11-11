import "server-only";
import type { HelpContext } from "@recx/shared";
import { db } from "@/lib/db";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { editorialAllowed, getHelpState, helpClosed, hintAllowed } from "@/lib/help/access";
import { CLOSED_CONTEXT_MESSAGE, editorialLockReason, hintLockedMessage } from "@/lib/help/copy";
import { revealHintSchema, viewEditorialSchema, type HintTier } from "@/lib/help/schema";
import { renderMarkdown } from "@/lib/markdown";

/**
 * The bodies of the revealHint / viewEditorial server actions, with the help
 * context as an explicit server-side argument (the actions pass the
 * workspace's; tests pass CONTEST and ASSESSMENT). Input is parsed here, the
 * chokepoint is asked again on every call — whatever the page showed — and
 * only then is a reveal recorded and content returned.
 *
 * Reveals are not audited: like a practice submission they are the
 * student's own study activity, and the HintReveal / EditorialView row (with
 * its timestamp) is itself the record the ASSISTED rule reads.
 */

const NOT_AVAILABLE = "That problem is not available.";

export interface RevealedHint {
  tier: HintTier;
  /** Sanitised HTML (renderMarkdown). */
  html: string;
}

export interface RevealedEditorial {
  /** Sanitised HTML (renderMarkdown). */
  html: string;
}

export async function revealHintFor(userId: string, input: unknown, context: HelpContext): Promise<RevealedHint> {
  const { problemId, tier } = revealHintSchema.parse(input);
  const state = await getHelpState(userId, problemId, context);
  if (!state) throw new NotFoundError(NOT_AVAILABLE);
  if (helpClosed(state)) throw new ForbiddenError(CLOSED_CONTEXT_MESSAGE.hints);
  if (!hintAllowed(state, tier)) throw new ForbiddenError(hintLockedMessage(tier));

  const hint = await db.hint.findUnique({
    where: { problemVersionId_tier: { problemVersionId: state.liveVersionId, tier } },
    select: { id: true, contentMd: true },
  });
  if (!hint) throw new NotFoundError(`This problem has no hint ${tier}.`);

  // ON CONFLICT DO NOTHING: a double click or a second tab never fails and
  // never moves the first revealedAt.
  await db.hintReveal.createMany({
    data: [{ userId, problemId: state.problemId, hintId: hint.id, tier, context: state.context }],
    skipDuplicates: true,
  });
  return { tier, html: renderMarkdown(hint.contentMd) };
}

export async function viewEditorialFor(userId: string, input: unknown, context: HelpContext): Promise<RevealedEditorial> {
  const { problemId } = viewEditorialSchema.parse(input);
  const state = await getHelpState(userId, problemId, context);
  if (!state) throw new NotFoundError(NOT_AVAILABLE);
  if (helpClosed(state)) throw new ForbiddenError(CLOSED_CONTEXT_MESSAGE.editorial);
  if (!editorialAllowed(state)) throw new ForbiddenError(editorialLockReason(state));

  const editorial = await db.editorial.findUnique({
    where: { problemVersionId: state.liveVersionId },
    select: { contentMd: true },
  });
  if (!editorial) throw new NotFoundError("This problem has no editorial yet.");

  // The first view is what counts (firstViewedAt); later views change nothing.
  await db.editorialView.createMany({ data: [{ userId, problemId: state.problemId }], skipDuplicates: true });
  return { html: renderMarkdown(editorial.contentMd) };
}
