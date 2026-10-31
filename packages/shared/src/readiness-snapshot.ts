/**
 * Reading a stored readiness snapshot back (Phase 9c).
 *
 * The nightly job writes the component breakdown as JSON, keyed by TIER and
 * then by component. Every surface that renders readiness reads THAT, not a
 * fresh computation — a student who disputes a number months later has to be
 * able to argue from the row that produced the number they saw, and a page
 * that recomputed on request would show them a different one.
 *
 * So this module does the one honest thing in between: it rebuilds the
 * `ReadinessInputs` the snapshot was computed FROM, and hands them back to
 * the same `scoreTier` the job used. Nothing here reimplements the
 * arithmetic. That matters more than it sounds: a second implementation of
 * the weights for the UI is exactly how a card ends up disagreeing with the
 * database, and the student is the one who notices.
 *
 * A test asserts the round trip — rebuild a stored snapshot, score it, and
 * the tier scores equal the stored scalar columns.
 */

import { z } from "zod";
import { dayDifference } from "./time";
import { TOPICS, type Topic } from "./topics";
import {
  MISSING_REASONS,
  READINESS_COMPONENTS,
  READINESS_TIERS,
  TIER_TARGETS,
  missing,
  present,
  scoreAllTiers,
  type ComponentValue,
  type ReadinessComponent,
  type ReadinessInputs,
  type ReadinessTier,
  type TierScore,
} from "./readiness";

/**
 * One component as the job stored it.
 *
 * `weight` and `points` are stored although both are derivable, and
 * deliberately: `rulesVersion` can move on, and a row from last March has to
 * stay readable under the weights it was scored under rather than under
 * today's. The rebuild below uses the stored VALUE, which is the input; the
 * stored weight is what a dispute is read against.
 */
export const storedComponentSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("PRESENT"),
    value: z.number().min(0).max(1),
    weight: z.number().min(0).max(1),
    points: z.number(),
    limitingTopic: z.enum(TOPICS).optional(),
    perTopicTarget: z.number().positive().optional(),
  }),
  z.object({
    state: z.literal("MISSING"),
    reason: z.enum(MISSING_REASONS),
    weight: z.number().min(0).max(1),
  }),
]);

export type StoredComponent = z.infer<typeof storedComponentSchema>;

/** The whole `components` column: tier → component → entry. */
export const storedComponentsSchema = z.record(
  z.enum(READINESS_TIERS),
  z.record(z.enum(READINESS_COMPONENTS), storedComponentSchema),
);

export type StoredComponents = z.infer<typeof storedComponentsSchema>;

/**
 * The `topicUnassisted` column: all fourteen counts, so the MIN the breadth
 * figure came from is checkable rather than asserted.
 *
 * `catchall` rather than a closed record: a snapshot written before a future
 * taxonomy change may name a topic this build no longer knows, and the right
 * response is to ignore it, not to make an old row unreadable.
 */
export const topicUnassistedSchema = z.record(z.string(), z.number().int().min(0));

export type TopicUnassisted = Readonly<Partial<Record<Topic, number>>>;

/** Narrow the free-form stored keys to the taxonomy this build knows. */
export function topicCounts(stored: unknown): TopicUnassisted {
  const parsed = topicUnassistedSchema.safeParse(stored);
  if (!parsed.success) return {};
  const counts: Partial<Record<Topic, number>> = {};
  for (const topic of TOPICS) {
    const value = parsed.data[topic];
    if (typeof value === "number") counts[topic] = value;
  }
  return counts;
}

/** The first tier that scored this component, with its stored entry. */
function findComponent(
  components: StoredComponents,
  component: ReadinessComponent,
): StoredComponent | undefined {
  for (const tier of READINESS_TIERS) {
    const entry = components[tier]?.[component];
    if (entry) return entry;
  }
  return undefined;
}

/** A stored entry back as the `ComponentValue` the arithmetic takes. */
function valueOf(entry: StoredComponent | undefined): ComponentValue {
  if (!entry) return missing("NO_DATA_YET");
  return entry.state === "PRESENT" ? present(entry.value) : missing(entry.reason);
}

/**
 * Recover a solved count from a stored coverage figure.
 *
 * `coverage(solved, target)` is `solved / target` clamped at 1, so the count
 * comes back exactly — except when the student has MET the target, where the
 * clamp threw the surplus away. That is fine and it is not a rounding
 * compromise: a component at its target leaves zero points available, so it
 * never reaches a gap list or a next action, and the only thing the recovered
 * count is used for is the "N more problems" sentence.
 */
function solvedFrom(entry: StoredComponent | undefined, target: number): number {
  if (!entry || entry.state !== "PRESENT") return 0;
  if (entry.value >= 1) return target;
  return Math.round(entry.value * target);
}

/**
 * Rebuild the inputs a snapshot was computed from.
 *
 * Exact for every component the student can act on. The percentiles,
 * consistency and mock-interview figures are stored values and come back
 * unchanged; the coverage counts come back through `solvedFrom` above; the
 * fourteen unassisted counts are stored outright.
 */
export function inputsFromSnapshot(snapshot: {
  readonly components: unknown;
  readonly topicUnassisted: unknown;
}): ReadinessInputs {
  const components = storedComponentsSchema.parse(snapshot.components);
  const find = (component: ReadinessComponent) => findComponent(components, component);

  return {
    aptitudePercentile: valueOf(find("APTITUDE_PERCENTILE")),
    verbalPercentile: valueOf(find("VERBAL_PERCENTILE")),
    ratingPercentile: valueOf(find("RATING_PERCENTILE")),
    mockInterviewScore: valueOf(find("MOCK_INTERVIEW_SCORE")),
    consistency: valueOf(find("CONSISTENCY")),
    unassistedByTopic: topicCounts(snapshot.topicUnassisted),
    easyMediumSolved: solvedFrom(find("EASY_MEDIUM_COVERAGE"), TIER_TARGETS.SERVICE.coverage),
    mediumUnassisted: solvedFrom(find("MEDIUM_UNASSISTED_COVERAGE"), TIER_TARGETS.PRODUCT.coverage),
    mediumHardUnassisted: solvedFrom(find("MEDIUM_HARD_UNASSISTED_COVERAGE"), TIER_TARGETS.TOP.coverage),
  };
}

export interface RebuiltSnapshot {
  readonly inputs: ReadinessInputs;
  readonly tiers: Record<ReadinessTier, TierScore>;
}

/** The inputs and all three tier scores, from the stored row alone. */
export function rebuildSnapshot(snapshot: {
  readonly components: unknown;
  readonly topicUnassisted: unknown;
}): RebuiltSnapshot {
  const inputs = inputsFromSnapshot(snapshot);
  return { inputs, tiers: scoreAllTiers(inputs) };
}

/**
 * Does the rebuild agree with the scalar columns the row also stores?
 *
 * The scalar columns exist for indexing — the cohort dashboard sorts and
 * buckets on them without parsing JSON for 5,000 rows — and a scalar that
 * disagreed with the breakdown beside it would make the two surfaces show
 * different numbers for the same student. Returns the disagreements rather
 * than a boolean, so a test failure says which column and by how much.
 */
export function snapshotDisagreements(
  rebuilt: Record<ReadinessTier, TierScore>,
  stored: {
    readonly serviceScore: number | null;
    readonly productScore: number | null;
    readonly topScore: number | null;
    readonly serviceAvailableWeight: number;
    readonly productAvailableWeight: number;
    readonly topAvailableWeight: number;
  },
): string[] {
  const columns: Record<ReadinessTier, { score: number | null; weight: number }> = {
    SERVICE: { score: stored.serviceScore, weight: stored.serviceAvailableWeight },
    PRODUCT: { score: stored.productScore, weight: stored.productAvailableWeight },
    TOP: { score: stored.topScore, weight: stored.topAvailableWeight },
  };

  const out: string[] = [];
  for (const tier of READINESS_TIERS) {
    const column = columns[tier];
    const fresh = rebuilt[tier];
    const freshScore = fresh.availableWeight === 0 ? null : Math.round(fresh.score);
    if (column.score !== freshScore) {
      out.push(`${tier}: stored score ${column.score ?? "null"}, rebuilt ${freshScore ?? "null"}`);
    }
    if (column.weight !== Math.round(fresh.availableWeight)) {
      out.push(`${tier}: stored weight ${column.weight}, rebuilt ${Math.round(fresh.availableWeight)}`);
    }
  }
  return out;
}

/**
 * How many days before a figure is labelled stale.
 *
 * Two, not one: the job runs at 02:30, so a student opening the page the
 * following evening is looking at a figure under 24 hours old, and a "stale"
 * label on the normal case would teach them to ignore the label. Past two
 * days the nightly run has missed at least once and the date has to be said
 * out loud — a stale number labelled stale is useful, an unlabelled one is a
 * lie.
 */
export const READINESS_STALE_AFTER_DAYS = 2;

export function isStale(computedOn: string, today: string, after = READINESS_STALE_AFTER_DAYS): boolean {
  const days = dayDifference(computedOn, today);
  return Number.isFinite(days) && days > after;
}

/**
 * The three empty states, because "no readiness yet" has three causes and
 * only one of them is the student's to act on.
 *
 * Copy lives here rather than in the page so a copy test can assert it and a
 * redesign cannot quietly turn "not computed yet" into a zero.
 */
export const READINESS_EMPTY_STATES = {
  NONE: {
    heading: "Your readiness has not been worked out yet",
    body:
      "This is computed overnight from what you have practised. It will appear here after the next nightly run — usually by the morning after you start solving.",
    cta: "Start with a problem",
  },
  EXCLUDED: {
    heading: "Your readiness is no longer being updated",
    body:
      "Your account is no longer part of an active batch, so the nightly run has stopped including you. Everything you did is still recorded, and you can still take a signed copy of it with you.",
    cta: "Take a signed copy of your record",
  },
} as const;

/** What the figures will be computed FROM, shown while there is no snapshot. */
export const READINESS_WILL_COUNT: readonly string[] = Object.freeze([
  "Problems you solve — and separately, the ones you solve without a hint or an editorial",
  "How many of the fourteen topics you have actually touched, not just the ones you like",
  "Aptitude and verbal practice",
  "Rated contests, once you have entered three",
  "How many days you practise on, not how many hours",
]);
