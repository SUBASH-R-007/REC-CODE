import "server-only";
import { createHmac } from "node:crypto";
import {
  buildMockLayout,
  BlueprintUnfillable,
  mockExpiresAt,
  sectionAllowances,
  sectionEndsAt,
  type MockLayout,
  type PoolQuestion,
  type SectionBlueprint,
} from "@recx/shared";
import { db } from "@/lib/db";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { extraTimeFor } from "@/lib/aptitude/accommodation";
import { APTITUDE_POOL_SELECT } from "@/server/queries/aptitude-select";

/**
 * Starting and resuming a mock sitting (Phase 7c).
 *
 * This is where a candidate's paper comes into existence and where the clock
 * is set, and both are written ONCE: `seed`, `layout`, `startedAt` and
 * `expiresAt` are in the tuple `recx_refuse_mock_attempt_change` refuses to
 * change. So everything decided here is decided for good, and a resume
 * returns exactly the paper the candidate already had.
 *
 * The seed comes from the sitting's NATURAL KEY rather than its id — the
 * lesson Phase 6c learned from the database: seeding from the row id means
 * creating the row and then writing `seed` and `layout` into it, and the
 * write-once trigger correctly refuses that second write. The key is
 * `patternId:userId:attemptNumber`, which is known before the insert, so the
 * row is created complete.
 */

/** Per-pattern, so one leaked secret cannot precompute papers for every pattern. */
const SEED_NAMESPACE = "recx:mock-seed:v1";

export function mockSeed(args: {
  readonly secret: string;
  readonly patternId: string;
  readonly userId: string;
  readonly attemptNumber: number;
}): number {
  const mac = createHmac("sha256", `${SEED_NAMESPACE}:${args.secret}`)
    .update(`${args.patternId}:${args.userId}:${args.attemptNumber}`)
    .digest();
  // 31 bits: Postgres INTEGER is signed, and a negative seed would still work
  // but reads as a bug in a dispute.
  return mac.readUInt32BE(0) & 0x7fff_ffff;
}

export interface StartedSitting {
  readonly attemptId: string;
  readonly resumed: boolean;
}

/**
 * Start a sitting, or hand back the one already in progress.
 *
 * Idempotent on purpose: a candidate who double-clicks, or whose connection
 * dropped on the way to the first question, must not end up with two papers
 * and two clocks.
 */
export async function startOrResumeMock(args: {
  readonly userId: string;
  readonly slug: string;
  readonly now: Date;
}): Promise<StartedSitting> {
  const pattern = await db.mockPattern.findFirst({
    where: { slug: args.slug, status: "PUBLISHED" },
    select: {
      id: true,
      slug: true,
      sections: {
        orderBy: { position: "asc" },
        select: {
          id: true,
          key: true,
          position: true,
          topicMix: true,
          questionCount: true,
          timeLimitSec: true,
          shuffleQuestions: true,
          shuffleOptions: true,
          area: true,
        },
      },
    },
  });
  if (!pattern) throw new NotFoundError("That mock is not available.");
  if (pattern.sections.length === 0) {
    throw new ValidationError("That mock has no sections yet.");
  }

  const live = await db.mockAttempt.findFirst({
    where: { patternId: pattern.id, userId: args.userId, status: "IN_PROGRESS" },
    select: { id: true },
  });
  if (live) return { attemptId: live.id, resumed: true };

  const previous = await db.mockAttempt.aggregate({
    where: { patternId: pattern.id, userId: args.userId },
    _max: { attemptNumber: true },
  });
  const attemptNumber = (previous._max.attemptNumber ?? 0) + 1;

  const terms = await extraTimeFor(args.userId);
  const limits = pattern.sections.map((section) => section.timeLimitSec);
  const clock = mockExpiresAt(args.now, limits, terms.extra);

  const blueprints: SectionBlueprint[] = pattern.sections.map((section) => ({
    sectionId: section.id,
    key: section.key,
    position: section.position,
    // The jsonb column's shape is held by `AptitudeSection_topic_mix_check`
    // and by `mockSectionSchema` at the authoring boundary, so by the time a
    // row exists it is a list of {topic, count}. Prisma types it as JsonValue
    // either way, which is why the cast goes through `unknown`.
    topicMix: section.topicMix as unknown as SectionBlueprint["topicMix"],
    questionCount: section.questionCount,
    shuffleQuestions: section.shuffleQuestions,
    shuffleOptions: section.shuffleOptions,
  }));

  const seed = mockSeed({
    secret: pattern.id,
    patternId: pattern.id,
    userId: args.userId,
    attemptNumber,
  });

  let layout: MockLayout;
  try {
    layout = buildMockLayout({ seed, sections: blueprints, pool: await publishedPool(blueprints) });
  } catch (error) {
    if (error instanceof BlueprintUnfillable) {
      // The consequence of retiring a question surfaces here rather than as a
      // short paper. A candidate is told plainly that it is not their problem.
      throw new ValidationError(
        "This mock cannot be prepared right now — its question bank is short. Nothing you did caused this, and the placement cell has been told.",
      );
    }
    throw error;
  }

  const allowances = sectionAllowances(limits, terms.extra);
  const first = pattern.sections[0]!;
  const firstWindow = sectionEndsAt({
    now: args.now,
    allowedSec: allowances[0]!.allowedSec,
    attemptExpiresAt: clock.expiresAt,
  });

  try {
    const attempt = await db.$transaction(async (tx) => {
      const created = await tx.mockAttempt.create({
        data: {
          patternId: pattern.id,
          userId: args.userId,
          attemptNumber,
          seed,
          startedAt: args.now,
          expiresAt: clock.expiresAt,
          currentSectionPosition: first.position,
          layout: layout as unknown as object,
          accommodationFlags: terms.flags,
        },
        select: { id: true },
      });
      // Every section gets a row up front, so the palette and the result page
      // can render a paper the candidate has not reached yet without having to
      // invent rows on read.
      await tx.mockSectionState.createMany({
        data: pattern.sections.map((section, index) => ({
          attemptId: created.id,
          sectionId: section.id,
          position: section.position,
          ...(index === 0 ? { startedAt: args.now, endsAt: firstWindow.endsAt } : {}),
        })),
      });
      return created;
    });
    return { attemptId: attempt.id, resumed: false };
  } catch (error) {
    // Two tabs raced on the same `@@unique([patternId, userId, attemptNumber])`.
    // The other one won; hand back its sitting rather than an error.
    const existing = await db.mockAttempt.findFirst({
      where: { patternId: pattern.id, userId: args.userId, status: "IN_PROGRESS" },
      select: { id: true },
    });
    if (existing) return { attemptId: existing.id, resumed: true };
    throw error instanceof Error ? new ConflictError("Could not start that mock. Try again.") : error;
  }
}

/**
 * The PUBLISHED pool for the topics a pattern draws on.
 *
 * Only PUBLISHED, and only the topics actually needed — a pattern asking for
 * four topics must not read 2,000 rows. Retired questions are excluded, which
 * is the whole of "retiring is allowed, serving is not".
 */
async function publishedPool(blueprints: readonly SectionBlueprint[]): Promise<PoolQuestion[]> {
  const topics = [...new Set(blueprints.flatMap((s) => s.topicMix.map((entry) => entry.topic)))];
  const rows = await db.aptitudeQuestion.findMany({
    where: { status: "PUBLISHED", topic: { in: topics } },
    select: APTITUDE_POOL_SELECT,
  });
  return rows.map((row) => ({
    id: row.id,
    topic: row.topic,
    optionCount: row.options.length,
    passageId: row.passageId,
  }));
}
