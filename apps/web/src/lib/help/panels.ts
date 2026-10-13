import "server-only";
import type { HelpContext } from "@recx/shared";
import { db } from "@/lib/db";
import { editorialAllowed, getHelpState, helpClosed, hintAllowed, type HelpState } from "@/lib/help/access";
import {
  CLOSED_CONTEXT_MESSAGE,
  editorialLockReason,
  editorialWarning,
  hintCondition,
  hintProgress,
  hintWarning,
} from "@/lib/help/copy";
import { HINT_TIERS, type HintTier } from "@/lib/help/schema";
import { renderMarkdown } from "@/lib/markdown";

/**
 * View models for the workspace's Hints and Editorial tabs. Every decision
 * is read from the chokepoint (getHelpState); content is loaded only for
 * what it allows AND the student has already revealed, so a locked hint's
 * text never leaves the database through this path.
 */

const UNAVAILABLE = "Help is not available for this problem.";
const STALE = "This problem was updated since the page loaded. Reload the page to see its latest version.";

type CommonView =
  | { kind: "unavailable"; message: string }
  | { kind: "closed"; message: string }
  | { kind: "stale"; message: string }
  | { kind: "empty" };

export type HintRowView =
  | { tier: HintTier; state: "locked"; condition: string }
  | { tier: HintTier; state: "available"; warning: string | null }
  | { tier: HintTier; state: "revealed"; html: string };

export type HintsPanelView = CommonView | { kind: "ready"; progress: string; rows: HintRowView[] };

export type EditorialPanelView =
  | CommonView
  | { kind: "locked"; reason: string }
  | { kind: "available"; warning: string | null }
  | { kind: "viewed"; html: string };

function isTier(tier: number): tier is HintTier {
  return (HINT_TIERS as readonly number[]).includes(tier);
}

/** Shared preamble: the chokepoint state, or the view that ends the panel early. */
async function resolve(
  userId: string,
  problemId: string,
  versionId: string,
  context: HelpContext,
  closedMessage: string,
  now: Date | undefined,
): Promise<{ state: HelpState } | { view: CommonView }> {
  const state = await getHelpState(userId, problemId, context, { now });
  if (!state) return { view: { kind: "unavailable", message: UNAVAILABLE } };
  if (helpClosed(state)) return { view: { kind: "closed", message: closedMessage } };
  // The panel shows the help of the version whose statement is on screen; if
  // a new version went live in between, say so rather than mix the two.
  if (state.liveVersionId !== versionId) return { view: { kind: "stale", message: STALE } };
  return { state };
}

export async function loadHintsPanel(
  userId: string,
  problemId: string,
  versionId: string,
  context: HelpContext,
  options: { now?: Date } = {},
): Promise<HintsPanelView> {
  const resolved = await resolve(userId, problemId, versionId, context, CLOSED_CONTEXT_MESSAGE.hints, options.now);
  if ("view" in resolved) return resolved.view;
  const { state } = resolved;

  const [hints, reveals] = await Promise.all([
    db.hint.findMany({ where: { problemVersionId: versionId }, select: { tier: true }, orderBy: { tier: "asc" } }),
    db.hintReveal.findMany({ where: { userId, problemId }, select: { tier: true } }),
  ]);
  const tiers = hints.map((h) => h.tier).filter(isTier);
  if (tiers.length === 0) return { kind: "empty" };

  // A tier revealed on an earlier version of this problem stays revealed:
  // the student already saw that level of help.
  const revealed = new Set(reveals.map((r) => r.tier));
  const showable = tiers.filter((tier) => hintAllowed(state, tier) && revealed.has(tier));
  const contents = showable.length
    ? await db.hint.findMany({
        where: { problemVersionId: versionId, tier: { in: showable } },
        select: { tier: true, contentMd: true },
      })
    : [];
  const html = new Map(contents.map((c) => [c.tier, renderMarkdown(c.contentMd)]));

  const rows = tiers.map((tier): HintRowView => {
    if (!hintAllowed(state, tier)) {
      const next = tier === state.access.maxHintTier + 1 ? state.access.nextUnlock : null;
      return { tier, state: "locked", condition: next ?? hintCondition(tier) };
    }
    const content = html.get(tier);
    if (content !== undefined) return { tier, state: "revealed", html: content };
    return { tier, state: "available", warning: hintWarning(tier, state.solved) };
  });

  return { kind: "ready", progress: hintProgress(state), rows };
}

export async function loadEditorialPanel(
  userId: string,
  problemId: string,
  versionId: string,
  context: HelpContext,
  options: { now?: Date } = {},
): Promise<EditorialPanelView> {
  const resolved = await resolve(userId, problemId, versionId, context, CLOSED_CONTEXT_MESSAGE.editorial, options.now);
  if ("view" in resolved) return resolved.view;
  const { state } = resolved;

  const editorial = await db.editorial.findUnique({ where: { problemVersionId: versionId }, select: { id: true } });
  if (!editorial) return { kind: "empty" };
  if (!editorialAllowed(state)) return { kind: "locked", reason: editorialLockReason(state) };

  const viewed = await db.editorialView.findUnique({
    where: { userId_problemId: { userId, problemId } },
    select: { firstViewedAt: true },
  });
  if (!viewed) return { kind: "available", warning: editorialWarning(state.solved) };

  const content = await db.editorial.findUnique({ where: { id: editorial.id }, select: { contentMd: true } });
  if (!content) return { kind: "empty" };
  return { kind: "viewed", html: renderMarkdown(content.contentMd) };
}
