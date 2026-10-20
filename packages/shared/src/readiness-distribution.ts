import { TOPICS, type Topic } from "./topics";
import { DISTRIBUTION_BUCKETS, TIER_TARGETS, type ReadinessTier } from "./readiness";

/**
 * Cohort shapes, and only shapes (Phase 9e).
 *
 * SPEC §5: "the dashboard never produces a shareable public ranking of
 * students by readiness." So there is deliberately no function in this module
 * that can return a per-student row. Everything here takes a list of figures
 * and gives back counts — buckets, cells, totals — and a caller that wanted
 * a league table would have to write the ordering itself, which
 * `tests/repo/placement-fence.test.ts` refuses.
 *
 * That is a design choice with teeth: a module that returned
 * `{ student, score }[]` "for the chart" would be one `sort()` away from the
 * thing the spec forbids, and the sort would live in a page where nobody
 * would look for it.
 *
 * Every bucket is over the NORMALISED figure — `score / availableWeight` as a
 * percentage — because a raw 70 on a tier capped at 85 is not 70 out of 100,
 * and a chart that mixed the two would put a well-prepared cohort in the
 * wrong bucket for a reason no reader could see.
 */

export interface Measured {
  /** 0–100, or null when nothing in the tier was measurable. */
  readonly score: number | null;
  /** The weight that was measurable, 0–100. */
  readonly availableWeight: number;
}

/** `score / availableWeight` as 0–100, or null when there is no denominator. */
export function normalise(row: Measured): number | null {
  if (row.score === null || row.availableWeight <= 0) return null;
  return Math.round((row.score / row.availableWeight) * 100);
}

export interface DistributionBucket {
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly count: number;
}

export interface Distribution {
  readonly tier: ReadinessTier;
  readonly buckets: readonly DistributionBucket[];
  /** How many students had a score at all. The chart's denominator. */
  readonly measured: number;
  /**
   * How many had NOTHING measurable in this tier. Reported beside the chart
   * rather than dropped: a bar chart over 400 of 5,000 students, drawn
   * without saying so, is the most misleading thing this surface could do.
   */
  readonly unmeasurable: number;
}

/**
 * The fixed five buckets, counted over the normalised figure.
 *
 * Fixed rather than computed from the data (quintiles, say) because a bucket
 * whose boundaries moved with the cohort would make two terms incomparable,
 * and comparing terms is the only reason to keep a distribution at all.
 */
export function distribution(tier: ReadinessTier, rows: readonly Measured[]): Distribution {
  const counts = DISTRIBUTION_BUCKETS.map(() => 0);
  let measured = 0;
  let unmeasurable = 0;

  for (const row of rows) {
    const value = normalise(row);
    if (value === null) {
      unmeasurable += 1;
      continue;
    }
    measured += 1;
    const found = DISTRIBUTION_BUCKETS.findIndex((bucket) => value >= bucket.min && value <= bucket.max);
    // A value outside every bucket cannot happen — they cover 0–100 and
    // `normalise` rounds a ratio of two bounded numbers — but counting it
    // into the last one beats dropping it silently, which would make the
    // chart's total disagree with the cohort size for no visible reason.
    const index = found === -1 ? counts.length - 1 : found;
    counts[index] = (counts[index] ?? 0) + 1;
  }

  return {
    tier,
    buckets: DISTRIBUTION_BUCKETS.map((bucket, index) => ({ ...bucket, count: counts[index]! })),
    measured,
    unmeasurable,
  };
}

/** The caption every distribution chart carries, as a function so a test can assert it. */
export function distributionCaption(dist: Distribution): string {
  const total = dist.measured + dist.unmeasurable;
  const of = dist.measured === total ? `all ${total}` : `${dist.measured} of ${total}`;
  const tail =
    dist.unmeasurable > 0
      ? ` ${dist.unmeasurable} had nothing measurable in this tier and are not in the chart.`
      : "";
  return (
    `${dist.tier} readiness as a percentage of what was MEASURABLE for each student, ` +
    `over ${of} students.${tail}`
  );
}

export interface HeatmapCell {
  readonly section: string;
  readonly topic: Topic;
  /** Students in this section with fewer than the tier's per-topic target. */
  readonly behind: number;
  /** Students in this section with any readiness snapshot. The denominator. */
  readonly total: number;
}

export interface Heatmap {
  readonly sections: readonly string[];
  readonly topics: readonly Topic[];
  readonly cells: readonly HeatmapCell[];
  /** The per-topic target the "behind" count was taken against. */
  readonly perTopicTarget: number;
}

/**
 * The 14-topic × section weakness grid.
 *
 * Each cell is "how many students in this section are short of the target on
 * this topic", out of the section's total. A COUNT, printed in the cell —
 * SPEC §6 requires it, and the reason is that a heatmap whose only encoding
 * is colour is unreadable to a colour-blind reader and unquotable by anybody:
 * "the graphs column looks red" is not something a head of department can
 * act on, and "19 of 54 in section B" is.
 *
 * The target comes from PRODUCT by default, the tier breadth matters most
 * for; the caller may pass TOP's to see the same grid at interview depth.
 */
export function heatmap(
  rows: readonly { readonly section: string | null; readonly topicUnassisted: Readonly<Partial<Record<Topic, number>>> }[],
  tier: ReadinessTier = "PRODUCT",
): Heatmap {
  const perTopicTarget = TIER_TARGETS[tier].perTopic ?? 0;
  const bySection = new Map<string, { total: number; behind: Map<Topic, number> }>();

  for (const row of rows) {
    // A student with no section recorded still belongs in the grid: dropping
    // them would make the column totals disagree with the cohort size, and
    // an unexplained gap in a count is worse than a row labelled "—".
    const section = row.section ?? "—";
    let entry = bySection.get(section);
    if (!entry) {
      entry = { total: 0, behind: new Map() };
      bySection.set(section, entry);
    }
    entry.total += 1;
    for (const topic of TOPICS) {
      if ((row.topicUnassisted[topic] ?? 0) < perTopicTarget) {
        entry.behind.set(topic, (entry.behind.get(topic) ?? 0) + 1);
      }
    }
  }

  const sections = [...bySection.keys()].sort();
  const cells: HeatmapCell[] = [];
  for (const section of sections) {
    const entry = bySection.get(section)!;
    for (const topic of TOPICS) {
      cells.push({ section, topic, behind: entry.behind.get(topic) ?? 0, total: entry.total });
    }
  }
  return { sections, topics: [...TOPICS], cells, perTopicTarget };
}

/** A cell's share, 0–1. For the colour, which is a REDUNDANT encoding. */
export function cellShare(cell: HeatmapCell): number {
  return cell.total === 0 ? 0 : cell.behind / cell.total;
}

/**
 * The topics the whole cohort is weakest on, worst first.
 *
 * Topics, not students. This is the one ranking the phase permits and it
 * ranks the SYLLABUS: "nobody here has touched graphs" is a teaching
 * decision, and it is the output a head of department can act on without
 * ever seeing a name.
 */
export function weakestTopics(map: Heatmap, howMany = 3): Array<{ topic: Topic; behind: number; total: number }> {
  const totals = new Map<Topic, { behind: number; total: number }>();
  for (const cell of map.cells) {
    const entry = totals.get(cell.topic) ?? { behind: 0, total: 0 };
    entry.behind += cell.behind;
    entry.total += cell.total;
    totals.set(cell.topic, entry);
  }
  return [...totals]
    .map(([topic, entry]) => ({ topic, ...entry }))
    // Ties break on TOPICS order, so the answer is stable between runs.
    .sort((a, b) => b.behind - a.behind || TOPICS.indexOf(a.topic) - TOPICS.indexOf(b.topic))
    .slice(0, howMany);
}
