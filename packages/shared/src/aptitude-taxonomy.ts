/**
 * The aptitude taxonomy (Phase 7): three areas and 29 topics.
 *
 * SPEC §5 opens the phase by explaining why it is MVP-tier rather than a
 * later one:
 *
 *   The majority of REC's 5,000 students will be screened by an aptitude
 *   round before anyone looks at their code; a platform that is all DSA
 *   optimises for the top decile and ignores the cohort the placement cell is
 *   actually worried about.
 *
 * This file is the ONE definition of the taxonomy. The Prisma enums
 * `AptitudeArea` and `AptitudeTopic` are storage copies held identical by
 * `packages/db/test/enum-parity.test.ts`, and the per-area `topic IN (…)`
 * CHECK in the migration is generated from `APTITUDE_TOPIC_AREA` below — so
 * there is one list and not two. A question whose topic is free text, or
 * whose topic sits under the wrong area, is a question nobody can build a
 * "weakest topic" view from, and that view is the whole point of the phase
 * for a student who has been told they are "bad at aptitude".
 *
 * The 29 members are the spec's own prose list. The SPELLINGS and the
 * groupings are this phase's choice (`INTEREST` covers simple and compound;
 * `SERIES` covers number and letter series), recorded in
 * `docs/OPEN-QUESTIONS.md` for the placement cell to confirm — exactly as the
 * 14 problem topics in `topics.ts` were.
 */

export const APTITUDE_AREAS = ["QUANTITATIVE", "LOGICAL", "VERBAL"] as const;
export type AptitudeArea = (typeof APTITUDE_AREAS)[number];

export const APTITUDE_AREA_LABEL: Readonly<Record<AptitudeArea, string>> = {
  QUANTITATIVE: "Quantitative aptitude",
  LOGICAL: "Logical reasoning",
  VERBAL: "Verbal ability",
};

/**
 * All 29 topics, in area order. The ORDER is part of the contract: the Prisma
 * enum must hold the same members in the same order, so a value stored by one
 * side is readable by the other.
 */
export const APTITUDE_TOPICS = [
  // QUANTITATIVE (14)
  "PERCENTAGES",
  "PROFIT_LOSS",
  "TIME_SPEED_DISTANCE",
  "TIME_AND_WORK",
  "RATIO_PROPORTION",
  "AVERAGES_MIXTURES",
  "PERMUTATIONS_COMBINATIONS",
  "PROBABILITY",
  "NUMBER_SYSTEMS",
  "INTEREST",
  "AGES",
  "CALENDARS_CLOCKS",
  "MENSURATION",
  "DATA_INTERPRETATION",
  // LOGICAL (9)
  "SERIES",
  "BLOOD_RELATIONS",
  "SYLLOGISMS",
  "SEATING_ARRANGEMENT",
  "PUZZLES",
  "CODING_DECODING",
  "DATA_SUFFICIENCY",
  "DIRECTIONS",
  "STATEMENT_CONCLUSION",
  // VERBAL (6)
  "READING_COMPREHENSION",
  "SENTENCE_CORRECTION",
  "PARA_JUMBLES",
  "SYNONYMS_ANTONYMS",
  "CLOZE",
  "ERROR_SPOTTING",
] as const;
export type AptitudeTopic = (typeof APTITUDE_TOPICS)[number];

/**
 * Topic → area. The mapping is immutable (a percentage question will never
 * become a verbal one), which is why the database states it as a CHECK rather
 * than a trigger, generated from this record.
 */
export const APTITUDE_TOPIC_AREA: Readonly<Record<AptitudeTopic, AptitudeArea>> = {
  PERCENTAGES: "QUANTITATIVE",
  PROFIT_LOSS: "QUANTITATIVE",
  TIME_SPEED_DISTANCE: "QUANTITATIVE",
  TIME_AND_WORK: "QUANTITATIVE",
  RATIO_PROPORTION: "QUANTITATIVE",
  AVERAGES_MIXTURES: "QUANTITATIVE",
  PERMUTATIONS_COMBINATIONS: "QUANTITATIVE",
  PROBABILITY: "QUANTITATIVE",
  NUMBER_SYSTEMS: "QUANTITATIVE",
  INTEREST: "QUANTITATIVE",
  AGES: "QUANTITATIVE",
  CALENDARS_CLOCKS: "QUANTITATIVE",
  MENSURATION: "QUANTITATIVE",
  DATA_INTERPRETATION: "QUANTITATIVE",
  SERIES: "LOGICAL",
  BLOOD_RELATIONS: "LOGICAL",
  SYLLOGISMS: "LOGICAL",
  SEATING_ARRANGEMENT: "LOGICAL",
  PUZZLES: "LOGICAL",
  CODING_DECODING: "LOGICAL",
  DATA_SUFFICIENCY: "LOGICAL",
  DIRECTIONS: "LOGICAL",
  STATEMENT_CONCLUSION: "LOGICAL",
  READING_COMPREHENSION: "VERBAL",
  SENTENCE_CORRECTION: "VERBAL",
  PARA_JUMBLES: "VERBAL",
  SYNONYMS_ANTONYMS: "VERBAL",
  CLOZE: "VERBAL",
  ERROR_SPOTTING: "VERBAL",
};

export const APTITUDE_TOPIC_LABEL: Readonly<Record<AptitudeTopic, string>> = {
  PERCENTAGES: "Percentages",
  PROFIT_LOSS: "Profit & Loss",
  TIME_SPEED_DISTANCE: "Time, Speed & Distance",
  TIME_AND_WORK: "Time & Work",
  RATIO_PROPORTION: "Ratio & Proportion",
  AVERAGES_MIXTURES: "Averages & Mixtures",
  PERMUTATIONS_COMBINATIONS: "Permutations & Combinations",
  PROBABILITY: "Probability",
  NUMBER_SYSTEMS: "Number Systems",
  INTEREST: "Simple & Compound Interest",
  AGES: "Problems on Ages",
  CALENDARS_CLOCKS: "Calendars & Clocks",
  MENSURATION: "Mensuration",
  DATA_INTERPRETATION: "Data Interpretation",
  SERIES: "Number & Letter Series",
  BLOOD_RELATIONS: "Blood Relations",
  SYLLOGISMS: "Syllogisms",
  SEATING_ARRANGEMENT: "Seating Arrangement",
  PUZZLES: "Puzzles",
  CODING_DECODING: "Coding & Decoding",
  DATA_SUFFICIENCY: "Data Sufficiency",
  DIRECTIONS: "Direction Sense",
  STATEMENT_CONCLUSION: "Statement & Conclusion",
  READING_COMPREHENSION: "Reading Comprehension",
  SENTENCE_CORRECTION: "Sentence Correction",
  PARA_JUMBLES: "Para Jumbles",
  SYNONYMS_ANTONYMS: "Synonyms & Antonyms",
  CLOZE: "Cloze Test",
  ERROR_SPOTTING: "Error Spotting",
};

/**
 * The URL form of a topic — `time-speed-distance` for `TIME_SPEED_DISTANCE`.
 *
 * `/aptitude/[topic]` is a student-facing link, and `TIME_SPEED_DISTANCE` in
 * an address bar is the kind of thing that looks like a leaked internal name.
 * The two directions are generated from one list, so a new topic cannot
 * arrive with a slug nobody wrote.
 */
export const APTITUDE_TOPIC_SLUG: Readonly<Record<AptitudeTopic, string>> = Object.freeze(
  Object.fromEntries(APTITUDE_TOPICS.map((topic) => [topic, topic.toLowerCase().replaceAll("_", "-")])) as Record<
    AptitudeTopic,
    string
  >,
);

const SLUG_TO_TOPIC: ReadonlyMap<string, AptitudeTopic> = new Map(
  APTITUDE_TOPICS.map((topic) => [APTITUDE_TOPIC_SLUG[topic], topic]),
);

export function topicFromSlug(slug: string): AptitudeTopic | null {
  return SLUG_TO_TOPIC.get(slug.toLowerCase()) ?? null;
}

export function isAptitudeTopic(value: unknown): value is AptitudeTopic {
  return typeof value === "string" && (APTITUDE_TOPICS as readonly string[]).includes(value);
}

export function isAptitudeArea(value: unknown): value is AptitudeArea {
  return typeof value === "string" && (APTITUDE_AREAS as readonly string[]).includes(value);
}

export function areaOfTopic(topic: AptitudeTopic): AptitudeArea {
  return APTITUDE_TOPIC_AREA[topic];
}

/** The topics of one area, in taxonomy order. */
export function topicsOfArea(area: AptitudeArea): readonly AptitudeTopic[] {
  return APTITUDE_TOPICS.filter((topic) => APTITUDE_TOPIC_AREA[topic] === area);
}

/** How many topics each area holds: 14 quantitative, 9 logical, 6 verbal. */
export const APTITUDE_AREA_TOPIC_COUNT: Readonly<Record<AptitudeArea, number>> = Object.freeze({
  QUANTITATIVE: topicsOfArea("QUANTITATIVE").length,
  LOGICAL: topicsOfArea("LOGICAL").length,
  VERBAL: topicsOfArea("VERBAL").length,
});
