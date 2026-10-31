import "server-only";
import {
  APTITUDE_AREAS,
  APTITUDE_AREA_LABEL,
  APTITUDE_TOPICS,
  APTITUDE_TOPIC_AREA,
  APTITUDE_TOPIC_LABEL,
  APTITUDE_TOPIC_SLUG,
  MOCK_PERCENTILE_MIN_ATTEMPTS,
  patternNotice,
  type AptitudeArea,
  type AptitudeTopic,
} from "@recx/shared";
import { db } from "@/lib/db";
import { APTITUDE_PUBLIC_SELECT } from "@/server/queries/aptitude-select";

/**
 * What a student may read of the aptitude surface (Phase 7e).
 *
 * Every function here is scoped by `userId` and selects through
 * `APTITUDE_PUBLIC_SELECT` — everything needed to ASK a question and nothing
 * needed to answer it. `tests/repo/aptitude-answer-exposure.test.ts` requires
 * exactly that of this file, and the live canary sweep calls it as a student.
 *
 * What a student never sees here: a band, an integrity score, another
 * student's name, or a cohort percentile before the pattern has a cohort.
 */

export interface TopicProgress {
  readonly topic: AptitudeTopic;
  readonly slug: string;
  readonly label: string;
  readonly area: AptitudeArea;
  readonly attempted: number;
  readonly correct: number;
  readonly accuracyPercent: number | null;
  readonly available: number;
  readonly lastAttemptedAt: Date | null;
}

/**
 * Every topic, with this student's own accuracy and how many questions are
 * available.
 *
 * All 29 rather than only the attempted ones: a student who has never opened
 * "Blood Relations" needs to see that it exists, and a list that grows as
 * you use it hides the thing you have been avoiding. `available` comes from
 * a grouped count, not 29 queries.
 */
export async function topicProgressFor(userId: string): Promise<TopicProgress[]> {
  const [mine, pool] = await Promise.all([
    db.aptitudeUserTopicStat.findMany({
      where: { userId },
      select: { topic: true, attempted: true, correct: true, lastAttemptedAt: true },
    }),
    db.aptitudeQuestion.groupBy({
      by: ["topic"],
      where: { status: "PUBLISHED" },
      _count: { _all: true },
    }),
  ]);

  const byTopic = new Map(mine.map((row) => [row.topic, row]));
  const counts = new Map(pool.map((row) => [row.topic, row._count._all]));

  return APTITUDE_TOPICS.map((topic) => {
    const row = byTopic.get(topic);
    const attempted = row?.attempted ?? 0;
    return {
      topic,
      slug: APTITUDE_TOPIC_SLUG[topic],
      label: APTITUDE_TOPIC_LABEL[topic],
      area: APTITUDE_TOPIC_AREA[topic],
      attempted,
      correct: row?.correct ?? 0,
      // Null rather than zero for "never tried": a 0% that means "untouched"
      // is the kind of number a student reads as a verdict on themselves.
      accuracyPercent: attempted > 0 ? Math.round(((row?.correct ?? 0) / attempted) * 1000) / 10 : null,
      available: counts.get(topic) ?? 0,
      lastAttemptedAt: row?.lastAttemptedAt ?? null,
    };
  });
}

/** The areas, each with its topics, for the hub's three columns. */
export function topicsByArea(progress: readonly TopicProgress[]) {
  return APTITUDE_AREAS.map((area) => ({
    area,
    label: APTITUDE_AREA_LABEL[area],
    topics: progress.filter((row) => row.area === area),
  }));
}

export interface PatternCard {
  readonly slug: string;
  readonly name: string;
  readonly funnelLabel: string;
  readonly description: string;
  /** The notice SPEC §5 requires, from the one place it is spelled. */
  readonly notice: string;
  readonly sections: number;
  readonly totalQuestions: number;
  readonly totalTimeSec: number;
  readonly hasNegativeMarking: boolean;
  readonly cohortIsMeaningful: boolean;
  readonly medianPercent: number | null;
  /** This student's own best, if they have sat it. */
  readonly bestPercent: number | null;
  readonly liveAttemptId: string | null;
}

/** The published patterns, with this student's own history of each. */
export async function patternCardsFor(userId: string): Promise<PatternCard[]> {
  const patterns = await db.mockPattern.findMany({
    where: { status: "PUBLISHED" },
    orderBy: { slug: "asc" },
    select: {
      slug: true,
      name: true,
      funnelLabel: true,
      description: true,
      modelledOnCompany: true,
      totalQuestions: true,
      totalTimeSec: true,
      finalizedAttemptCount: true,
      medianPercent: true,
      sections: { select: { negativeMarkFraction: true } },
      attempts: {
        where: { userId },
        select: { id: true, status: true, percent: true },
        orderBy: { startedAt: "desc" },
      },
    },
  });

  return patterns.map((pattern) => {
    const finalised = pattern.attempts.filter(
      (attempt) => attempt.status === "SUBMITTED" || attempt.status === "AUTO_SUBMITTED",
    );
    const live = pattern.attempts.find((attempt) => attempt.status === "IN_PROGRESS") ?? null;
    return {
      slug: pattern.slug,
      name: pattern.name,
      funnelLabel: pattern.funnelLabel,
      description: pattern.description,
      notice: patternNotice(pattern),
      sections: pattern.sections.length,
      totalQuestions: pattern.totalQuestions,
      totalTimeSec: pattern.totalTimeSec,
      hasNegativeMarking: pattern.sections.some((section) => section.negativeMarkFraction > 0),
      // A percentile over four attempts is noise, and this is the only place
      // a student is told a number about the room they are in.
      cohortIsMeaningful: pattern.finalizedAttemptCount >= MOCK_PERCENTILE_MIN_ATTEMPTS,
      medianPercent:
        pattern.finalizedAttemptCount >= MOCK_PERCENTILE_MIN_ATTEMPTS ? pattern.medianPercent : null,
      bestPercent: finalised.length > 0 ? Math.max(...finalised.map((attempt) => attempt.percent)) : null,
      liveAttemptId: live?.id ?? null,
    };
  });
}

/** One pattern's cover page: everything stated BEFORE the clock starts. */
export async function patternCoverFor(slug: string, userId: string) {
  const pattern = await db.mockPattern.findFirst({
    where: { slug, status: "PUBLISHED" },
    select: {
      slug: true,
      name: true,
      funnelLabel: true,
      sourceNote: true,
      description: true,
      modelledOnCompany: true,
      totalQuestions: true,
      totalTimeSec: true,
      finalizedAttemptCount: true,
      medianPercent: true,
      sections: {
        orderBy: { position: "asc" },
        select: {
          position: true,
          label: true,
          questionCount: true,
          timeLimitSec: true,
          cutoffPercent: true,
          marksPerCorrect: true,
          negativeMarkFraction: true,
          allowBackNavigation: true,
        },
      },
      attempts: {
        where: { userId },
        orderBy: { startedAt: "desc" },
        select: { id: true, status: true, percent: true, passedOverall: true, finalizedAt: true },
      },
    },
  });
  if (!pattern) return null;
  return { ...pattern, notice: patternNotice(pattern) };
}

/**
 * One practice question for a topic, chosen for this student.
 *
 * The one they have least recently seen, then the ones they have not seen at
 * all — so practice moves through the topic rather than looping on whatever
 * the database returns first. `APTITUDE_PUBLIC_SELECT` only: the key and the
 * working arrive from the action, after the answer is committed.
 */
export async function nextPracticeQuestion(args: { readonly userId: string; readonly topic: AptitudeTopic }) {
  const question = await db.aptitudeQuestion.findFirst({
    where: { status: "PUBLISHED", topic: args.topic },
    orderBy: [{ stat: { lastServedAt: { sort: "asc", nulls: "first" } } }, { createdAt: "asc" }],
    select: { ...APTITUDE_PUBLIC_SELECT, passage: { select: { id: true, title: true, body: true } } },
  });
  return question;
}

/** How many PUBLISHED questions a topic has, for the empty state. */
export async function practiceCountFor(topic: AptitudeTopic): Promise<number> {
  return db.aptitudeQuestion.count({ where: { status: "PUBLISHED", topic } });
}
