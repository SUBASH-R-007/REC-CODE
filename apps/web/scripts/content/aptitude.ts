import { MOCK_PATTERN_SEEDS, mockPatternSchema, type MockPatternSeed } from "@recx/shared";
import type { Db } from "@recx/db";

/**
 * Seeding the six mock patterns (Phase 7).
 *
 * The patterns themselves live in `@recx/shared` — SPEC §5's gate test grades
 * "all seeded patterns" and a test in `packages/shared` cannot import
 * `apps/web`, so the data had to live beside the arithmetic. This module is
 * the part that writes them, and it is the only part that touches a database.
 *
 * Idempotent, and upserting on `[patternId, key]` rather than on position:
 * a position can be renumbered while a section stays the same section, and a
 * seed run that moved sections about would be a seed run that rescored
 * everybody who had sat the pattern.
 *
 * It refuses to touch a pattern anybody has SAT, which is not a courtesy —
 * `recx_refuse_used_pattern_change` would refuse the write anyway, and a
 * seeder that discovered that by crashing would leave the first three
 * patterns updated and the rest not. Checking first means the run reports
 * what it skipped instead.
 */

export interface PatternSeedResult {
  readonly slug: string;
  readonly action: "created" | "updated" | "skipped-sat" | "unchanged";
  readonly sections: number;
}

export async function syncSeededMockPatterns(db: Db, createdById: string | null): Promise<PatternSeedResult[]> {
  const results: PatternSeedResult[] = [];

  for (const seed of MOCK_PATTERN_SEEDS) {
    // The same gate an admin-authored pattern goes through: a seed the schema
    // would refuse is a seed nobody should be able to insert either.
    const parsed = mockPatternSchema.safeParse(seed);
    if (!parsed.success) {
      throw new Error(
        `The seeded pattern ${seed.slug} does not satisfy mockPatternSchema: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")} ${issue.message}`)
          .join("; ")}`,
      );
    }

    const existing = await db.mockPattern.findUnique({
      where: { slug: seed.slug },
      select: { id: true, status: true, _count: { select: { attempts: true } } },
    });

    if (existing) {
      const sat = await db.mockAttempt.count({
        where: { patternId: existing.id, status: { in: ["SUBMITTED", "AUTO_SUBMITTED"] } },
      });
      if (sat > 0) {
        // A score has to mean what it meant when the candidate sat it.
        results.push({ slug: seed.slug, action: "skipped-sat", sections: seed.sections.length });
        continue;
      }
    }

    const pattern = await db.mockPattern.upsert({
      where: { slug: seed.slug },
      create: {
        slug: seed.slug,
        name: seed.name,
        funnelLabel: seed.funnelLabel,
        sourceNote: seed.sourceNote,
        modelledOnCompany: seed.modelledOnCompany,
        description: seed.description,
        createdById,
      },
      update: {
        name: seed.name,
        funnelLabel: seed.funnelLabel,
        sourceNote: seed.sourceNote,
        modelledOnCompany: seed.modelledOnCompany,
        description: seed.description,
      },
      select: { id: true },
    });

    for (const section of seed.sections) {
      await db.aptitudeSection.upsert({
        where: { patternId_key: { patternId: pattern.id, key: section.key } },
        create: {
          patternId: pattern.id,
          position: section.position,
          key: section.key,
          label: section.label,
          area: section.area,
          topicMix: section.topicMix as never,
          questionCount: section.questionCount,
          timeLimitSec: section.timeLimitSec,
          cutoffPercent: section.cutoffPercent,
          marksPerCorrect: section.marksPerCorrect,
          negativeMarkFraction: section.negativeMarkFraction,
          allowBackNavigation: section.allowBackNavigation,
          shuffleQuestions: section.shuffleQuestions,
          shuffleOptions: section.shuffleOptions,
        },
        update: {
          position: section.position,
          label: section.label,
          area: section.area,
          topicMix: section.topicMix as never,
          questionCount: section.questionCount,
          timeLimitSec: section.timeLimitSec,
          cutoffPercent: section.cutoffPercent,
          marksPerCorrect: section.marksPerCorrect,
          negativeMarkFraction: section.negativeMarkFraction,
          allowBackNavigation: section.allowBackNavigation,
        },
      });
    }

    // A section the seed no longer declares is removed, so an edited seed
    // does not leave a ghost section scoring a paper nobody designed.
    await db.aptitudeSection.deleteMany({
      where: { patternId: pattern.id, key: { notIn: seed.sections.map((section) => section.key) } },
    });

    /**
     * PUBLISHED last, and only here: `MockPattern_published_has_paper`
     * refuses a published pattern with no sections, so publishing before the
     * sections exist would fail on a fresh database and pass on a re-run —
     * the worst kind of seed bug.
     */
    await db.mockPattern.update({ where: { id: pattern.id }, data: { status: "PUBLISHED" } });

    results.push({
      slug: seed.slug,
      action: existing ? "updated" : "created",
      sections: seed.sections.length,
    });
  }

  return results;
}

/** Every topic the seeded patterns draw on, for the seeder's own report. */
export function seededPatternTopics(): string[] {
  const topics = new Set<string>();
  for (const pattern of MOCK_PATTERN_SEEDS) {
    for (const section of pattern.sections) {
      for (const entry of section.topicMix) topics.add(entry.topic);
    }
  }
  return [...topics].sort();
}

export type { MockPatternSeed };
