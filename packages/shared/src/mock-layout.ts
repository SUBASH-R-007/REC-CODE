import { z } from "zod";
import { questionSeed, shuffled, xoshiro128ss } from "./exam-randomise";
import type { AptitudeTopic } from "./aptitude-taxonomy";
import type { TopicMixEntry } from "./mock-pattern";

/**
 * The per-candidate paper (Phase 7c): which questions, in which order, with
 * options in which order.
 *
 * Seeded and pure, so a disputed paper is reproducible from
 * `MockAttempt.seed` alone — the same reason Phase 6b stored a seed. Two
 * structural rules the drawing has to keep:
 *
 *   * a PASSAGE group moves as a BLOCK and is never split. Shuffling a
 *     passage's questions apart would show a candidate question 3 of a
 *     passage they have not been given, and shuffling them across a section
 *     boundary would show them the passage twice;
 *   * a blueprint the PUBLISHED pool cannot fill raises an authoring error
 *     rather than quietly building a short paper. The consequence of retiring
 *     a question then surfaces on the pattern page, where somebody can act on
 *     it, instead of on a candidate's screen mid-sitting
 *     (`docs/OPEN-QUESTIONS.md`: retiring is allowed, serving is not).
 *
 * Selections are stored in the question's OWN option order, never the shown
 * one, so a stored answer is readable without the layout and stays correct if
 * the shuffle ever changes.
 */

export const MOCK_LAYOUT_VERSION = 1;

/** One question as this candidate will see it. */
export interface MockLayoutQuestion {
  readonly questionId: string;
  /** 0-based index within the section, as served. */
  readonly index: number;
  readonly topic: AptitudeTopic;
  /**
   * The question's own option indexes, in the order they are SHOWN:
   * `optionOrder[shown] = original`. Empty for a numeric-entry question.
   */
  readonly optionOrder: readonly number[];
  /** The passage group this question belongs to, if any. */
  readonly passageId: string | null;
}

export interface MockLayoutSection {
  readonly sectionId: string;
  readonly key: string;
  readonly position: number;
  readonly questions: readonly MockLayoutQuestion[];
}

export interface MockLayout {
  readonly v: typeof MOCK_LAYOUT_VERSION;
  readonly sections: readonly MockLayoutSection[];
}

const layoutQuestionSchema = z
  .object({
    questionId: z.string().min(1),
    index: z.number().int().min(0),
    topic: z.string().min(1),
    optionOrder: z.array(z.number().int().min(0)),
    passageId: z.string().min(1).nullable(),
  })
  .strict();

/**
 * Versioned, so adding a field later changes what goes into `questions` and
 * nothing about how a stored layout is read.
 */
export const mockLayoutSchema = z
  .object({
    v: z.literal(MOCK_LAYOUT_VERSION),
    sections: z
      .array(
        z
          .object({
            sectionId: z.string().min(1),
            key: z.string().min(1),
            position: z.number().int().min(1),
            questions: z.array(layoutQuestionSchema),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export function parseMockLayout(value: unknown): MockLayout {
  return mockLayoutSchema.parse(value) as MockLayout;
}

// ── Drawing a paper ─────────────────────────────────────────────────────

/** A candidate question from the PUBLISHED pool. */
export interface PoolQuestion {
  readonly id: string;
  readonly topic: AptitudeTopic;
  readonly optionCount: number;
  readonly passageId: string | null;
  /** Options the author pinned — "None of the above" moved to the middle is nonsense. */
  readonly fixedOptionIndexes?: readonly number[];
}

export interface SectionBlueprint {
  readonly sectionId: string;
  readonly key: string;
  readonly position: number;
  readonly topicMix: readonly TopicMixEntry[];
  readonly questionCount: number;
  readonly shuffleQuestions: boolean;
  readonly shuffleOptions: boolean;
}

export interface BlueprintShortfall {
  readonly sectionKey: string;
  readonly topic: AptitudeTopic;
  readonly wanted: number;
  readonly available: number;
  /**
   * "pool" — there are not enough published questions.
   * "grouping" — there are enough, but this topic's questions come in passage
   * groups that cannot add up to exactly `wanted` without splitting one.
   */
  readonly cause: "pool" | "grouping";
}

export class BlueprintUnfillable extends Error {
  readonly shortfalls: readonly BlueprintShortfall[];

  constructor(shortfalls: readonly BlueprintShortfall[]) {
    super(
      `This pattern cannot be filled from the published pool: ${shortfalls
        .map((s) =>
          s.cause === "pool"
            ? `${s.sectionKey} needs ${s.wanted} ${s.topic} and has ${s.available}`
            : `${s.sectionKey} needs ${s.wanted} ${s.topic}, and the ${s.available} available come in passage groups that cannot total ${s.wanted} without splitting one`,
        )
        .join("; ")}.`,
    );
    this.name = "BlueprintUnfillable";
    this.shortfalls = shortfalls;
  }
}

/**
 * One drawable unit: a standalone question, or a whole passage group.
 *
 * The pool is drawn in units and never in questions, which is what makes
 * "a passage group never crosses a section boundary" true by construction
 * rather than by a later repair.
 */
interface DrawUnit {
  readonly questions: readonly PoolQuestion[];
  readonly size: number;
}

/**
 * Choose units totalling exactly `need`, in the units' own order.
 *
 * Exactly, because a section is as long as its blueprint says and a candidate
 * must not be given a short one. A greedy pass is not enough: needing four
 * from groups of three, three, two and two would fail greedily and succeed as
 * two plus two. This is 0/1 subset-sum with reconstruction — bounded by the
 * section length (at most 100) and the pool, and deterministic in the unit
 * order, so the same seed gives the same draw.
 */
function chooseUnits(units: readonly DrawUnit[], need: number): number[] | null {
  if (need === 0) return [];
  // reach[k] = { unit, from } for the first way found to total k.
  const reach = new Array<{ unit: number; from: number } | null>(need + 1).fill(null);
  const reachable = new Array<boolean>(need + 1).fill(false);
  reachable[0] = true;
  for (const [index, unit] of units.entries()) {
    if (unit.size > need) continue;
    for (let k = need; k >= unit.size; k--) {
      if (reachable[k] || !reachable[k - unit.size]) continue;
      reachable[k] = true;
      reach[k] = { unit: index, from: k - unit.size };
    }
    if (reachable[need]) break;
  }
  if (!reachable[need]) return null;

  const chosen: number[] = [];
  for (let k = need; k > 0; ) {
    const step = reach[k]!;
    chosen.push(step.unit);
    k = step.from;
  }
  return chosen.reverse();
}

/** Group a topic's questions into drawable units, passages whole. */
function drawUnitsOf(questions: readonly PoolQuestion[]): DrawUnit[] {
  return passageBlocks(questions).map((block) => ({ questions: block, size: block.length }));
}

/**
 * Build one candidate's paper.
 *
 * Deterministic in `seed`: the same seed and the same pool give the same
 * paper, every time and on any engine. The pool is consumed across sections,
 * so no question appears twice in one paper even where two sections draw on
 * the same topic.
 */
export function buildMockLayout(args: {
  readonly seed: number;
  readonly sections: readonly SectionBlueprint[];
  readonly pool: readonly PoolQuestion[];
}): MockLayout {
  // Index the pool by topic, in a seeded order, so the draw is reproducible
  // and is not simply "the oldest questions, always".
  const byTopic = new Map<AptitudeTopic, DrawUnit[]>();
  for (const question of args.pool) {
    const list = byTopic.get(question.topic);
    if (list) list.push({ questions: [question], size: 1 });
    else byTopic.set(question.topic, [{ questions: [question], size: 1 }]);
  }
  // Re-group into units (passages whole) and shuffle the units.
  for (const topic of [...byTopic.keys()]) {
    const questions = byTopic.get(topic)!.flatMap((u) => u.questions);
    byTopic.set(
      topic,
      shuffled(drawUnitsOf(questions), xoshiro128ss(questionSeed(args.seed, topicSalt(topic)))),
    );
  }

  // Draw in one pass, collecting every shortfall rather than the first, so an
  // author sees the whole list and can fix the blueprint once.
  const shortfalls: BlueprintShortfall[] = [];
  const drawnBySection = new Map<string, PoolQuestion[]>();

  for (const section of args.sections) {
    const drawn: PoolQuestion[] = [];
    for (const entry of section.topicMix) {
      const available = byTopic.get(entry.topic) ?? [];
      const availableQuestions = available.reduce((sum, unit) => sum + unit.size, 0);
      if (availableQuestions < entry.count) {
        shortfalls.push({
          sectionKey: section.key,
          topic: entry.topic,
          wanted: entry.count,
          available: availableQuestions,
          cause: "pool",
        });
        continue;
      }
      const chosen = chooseUnits(available, entry.count);
      if (chosen === null) {
        shortfalls.push({
          sectionKey: section.key,
          topic: entry.topic,
          wanted: entry.count,
          available: availableQuestions,
          cause: "grouping",
        });
        continue;
      }
      const picked = new Set(chosen);
      for (const index of chosen) drawn.push(...available[index]!.questions);
      // Consume them, so no question and no passage appears twice in a paper.
      byTopic.set(
        entry.topic,
        available.filter((_, index) => !picked.has(index)),
      );
    }
    drawnBySection.set(section.key, drawn);
  }

  if (shortfalls.length > 0) throw new BlueprintUnfillable(shortfalls);

  const sections: MockLayoutSection[] = [];
  for (const section of args.sections) {
    const drawn = drawnBySection.get(section.key) ?? [];
    const ordered = section.shuffleQuestions
      ? orderWithPassagesTogether(drawn, xoshiro128ss(questionSeed(args.seed, section.position * 1_000 + 7)))
      : groupPassagesTogether(drawn);

    sections.push({
      sectionId: section.sectionId,
      key: section.key,
      position: section.position,
      questions: ordered.map((question, index) => ({
        questionId: question.id,
        index,
        topic: question.topic,
        optionOrder: section.shuffleOptions
          ? shuffleOptionsKeepingFixed(question, xoshiro128ss(questionSeed(args.seed, hashId(question.id))))
          : identityOrder(question.optionCount),
        passageId: question.passageId,
      })),
    });
  }

  return { v: MOCK_LAYOUT_VERSION, sections };
}

/**
 * Shuffle questions while keeping every passage group contiguous.
 *
 * The groups are shuffled among themselves and the questions WITHIN a group
 * are shuffled too, so two candidates see the same passage with its questions
 * in different orders — but nobody ever sees a passage's questions split
 * across the section, which would mean reading the passage twice or answering
 * about one they have not been shown.
 */
function orderWithPassagesTogether(questions: readonly PoolQuestion[], random: () => number): PoolQuestion[] {
  const blocks = passageBlocks(questions);
  return shuffled(blocks, random).flatMap((block) => (block.length === 1 ? block : shuffled(block, random)));
}

function groupPassagesTogether(questions: readonly PoolQuestion[]): PoolQuestion[] {
  return passageBlocks(questions).flat();
}

/** Standalone questions are blocks of one; a passage's questions are one block. */
function passageBlocks(questions: readonly PoolQuestion[]): PoolQuestion[][] {
  const blocks: PoolQuestion[][] = [];
  const byPassage = new Map<string, PoolQuestion[]>();
  for (const question of questions) {
    if (question.passageId === null) {
      blocks.push([question]);
      continue;
    }
    const existing = byPassage.get(question.passageId);
    if (existing) {
      existing.push(question);
    } else {
      const block = [question];
      byPassage.set(question.passageId, block);
      blocks.push(block);
    }
  }
  return blocks;
}

/**
 * Shuffle a question's options, leaving the pinned ones where they are.
 *
 * SPEC §5's randomisation clause: "MCQ option order (excluding fixedPosition
 * options like 'None of the above')". Moving that one to the middle makes the
 * question nonsense.
 */
function shuffleOptionsKeepingFixed(question: PoolQuestion, random: () => number): number[] {
  const fixed = new Set(question.fixedOptionIndexes ?? []);
  const movable = identityOrder(question.optionCount).filter((index) => !fixed.has(index));
  const permuted = shuffled(movable, random);
  const out: number[] = [];
  let next = 0;
  for (let position = 0; position < question.optionCount; position++) {
    out.push(fixed.has(position) ? position : permuted[next++]!);
  }
  return out;
}

const identityOrder = (count: number): number[] => Array.from({ length: count }, (_, i) => i);

/** A stable small integer per topic, to salt its pool order. */
function topicSalt(topic: string): number {
  let h = 2_166_136_261;
  for (let i = 0; i < topic.length; i++) {
    h ^= topic.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }
  return (h >>> 0) % 100_000;
}

/** A stable 32-bit salt per question id, so one question's options are fixed. */
function hashId(id: string): number {
  let h = 2_166_136_261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }
  return (h >>> 0) % 1_000_000;
}

// ── Mapping between shown and stored ────────────────────────────────────

/**
 * Turn the indexes a candidate clicked into the question's own indexes.
 *
 * `MockAttemptAnswer.selectedIndexes` is stored in the question's own option
 * order, so re-grading after a shuffle change is still correct and an answer
 * row is readable without the layout. An index outside the permutation is
 * dropped rather than stored: it is either a stale client or a crafted
 * request, and in both cases storing it would corrupt the answer.
 */
export function mapSelectionToOriginal(shown: readonly number[], optionOrder: readonly number[]): number[] {
  const out: number[] = [];
  for (const index of shown) {
    const original = optionOrder[index];
    if (original !== undefined && !out.includes(original)) out.push(original);
  }
  return out.sort((a, b) => a - b);
}

/** The inverse: which shown positions a stored answer lit up. */
export function mapOriginalToShown(original: readonly number[], optionOrder: readonly number[]): number[] {
  const out: number[] = [];
  for (const [shown, source] of optionOrder.entries()) {
    if (original.includes(source)) out.push(shown);
  }
  return out;
}

/** A question's options in the order this candidate sees them. */
export function mapOptionsToShown<T>(options: readonly T[], optionOrder: readonly number[]): T[] {
  return optionOrder.map((index) => options[index]!);
}

/** Every question in the layout, flattened, for the stat and serving counters. */
export function layoutQuestionIds(layout: MockLayout): string[] {
  return layout.sections.flatMap((section) => section.questions.map((q) => q.questionId));
}

/** One section of a layout, by its key. */
export function layoutSection(layout: MockLayout, key: string): MockLayoutSection | null {
  return layout.sections.find((section) => section.key === key) ?? null;
}
