import "server-only";

/**
 * Which models actually answered (Phase 15g).
 *
 * `AiAssist.modelId` has recorded the model that answered since Phase 12b,
 * and nothing ever read it back. With a closed catalogue of four ids that
 * was almost information; now that a super-admin can name any model it is
 * the feedback loop — the only way to tell whether changing model was an
 * improvement, or whether the one they chose last week has started
 * failing.
 *
 * The folding is here rather than in the page because it is the only part
 * with a decision in it: a `groupBy` over (model, failed) returns two rows
 * per model, and which column each belongs in — plus which timestamp is the
 * latest — is worth a test rather than a glance.
 *
 * Nothing here touches an answer or a student. Counts and a timestamp.
 */

export interface AiUsageGroup {
  readonly modelId: string;
  readonly failed: boolean;
  readonly count: number;
  readonly lastAt: Date | null;
}

export interface AiModelUsage {
  readonly modelId: string;
  /** Asks this model answered. */
  readonly answered: number;
  /** Asks it did not: a timeout, a status, an endpoint that is not a model. */
  readonly failed: number;
  /** When it was last asked at all, answered or not. */
  readonly lastAt: Date | null;
}

/** Busiest first, counting failures: a model that only fails is worth seeing. */
export function foldAiUsage(groups: readonly AiUsageGroup[]): AiModelUsage[] {
  const byModel = new Map<string, { answered: number; failed: number; lastAt: Date | null }>();
  for (const group of groups) {
    const entry = byModel.get(group.modelId) ?? { answered: 0, failed: 0, lastAt: null };
    if (group.failed) entry.failed += group.count;
    else entry.answered += group.count;
    if (group.lastAt && (entry.lastAt === null || group.lastAt > entry.lastAt)) entry.lastAt = group.lastAt;
    byModel.set(group.modelId, entry);
  }
  return [...byModel.entries()]
    .map(([modelId, counts]) => ({ modelId, ...counts }))
    .sort((a, b) => b.answered + b.failed - (a.answered + a.failed) || a.modelId.localeCompare(b.modelId));
}
