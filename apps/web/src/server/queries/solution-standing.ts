import "server-only";
import { Prisma } from "@recx/db";
import {
  COMPLEXITY_CLASSES,
  rankSolution,
  type ComplexityClass,
  type PeerSolution,
  type StandingOutcome,
} from "@recx/shared";
import { db } from "@/lib/db";

/**
 * Where one accepted practice solution stands among the others (Phase 17).
 *
 * The shaping, the thresholds and the refusal live in
 * `@recx/shared/solution-standing`; this module is only the population —
 * which is where every decision that could make the comparison unfair gets
 * made, so each one is written down:
 *
 *   * **One row per student, theirs fastest.** `DISTINCT ON ("userId")`
 *     ordered by the normalised time, so a student who submitted forty
 *     times while tuning counts once. Time, memory and growth all come off
 *     that same one submission rather than being three different students'
 *     bests stitched together, so the distribution is a distribution of
 *     SOLUTIONS.
 *   * **The same frozen revision, and the same language.** Tests and limits
 *     change between revisions, and comparing a Python time to a C++ time
 *     ranks the language rather than the solution.
 *   * **PRACTICE only, Accepted only.** A contest or an assessment
 *     submission is not a practice solution and is never in this
 *     population; a submission that failed has no time worth comparing.
 *   * **Normalised for the host.** Practice work is not restricted to a
 *     calibrated fleet, so two accepted solutions can differ by a third
 *     purely because of the node. Every row stores the calibration of the
 *     node that judged it — for exactly this reason — so the ordering is on
 *     `cpuMs x calibrationScore`, and the numbers a student is shown are
 *     divided back by THEIR OWN node's calibration. What they read is
 *     therefore "what these solutions would have cost on the machine that
 *     judged mine", which is the only scale they have any intuition for.
 *   * **Nothing identifying.** The query returns a time, a memory figure
 *     and a growth class per row. No name, no id, no profile, nothing
 *     ordered in a way a position could be read back from.
 */

/** A peer row: one student's fastest accepted solution, calibration-weighted. */
interface PeerRow {
  /** cpuMs x calibrationScore — comparable across nodes, in no useful unit. */
  timeScore: number;
  memoryKb: number;
  growth: string | null;
}

const asClass = (value: string | null): ComplexityClass | null =>
  value !== null && (COMPLEXITY_CLASSES as readonly string[]).includes(value) ? (value as ComplexityClass) : null;

/**
 * Where this submission sits, or null when there is nothing to say.
 *
 * Null rather than a refusal in three cases, all of which mean "this is not
 * a ranked surface" rather than "there are too few peers": the submission is
 * not an accepted practice submission, the viewer may not read it, or it
 * carries no calibration from the node that judged it — which only old rows
 * and a node reporting none can be, and without it there is no honest scale
 * to put the peers on.
 *
 * The caller has already authorised the read; this takes the id so that the
 * calibration score it needs never has to travel out to a page.
 */
export async function getSolutionStanding(submissionId: string): Promise<StandingOutcome | null> {
  const mine = await db.submission.findUnique({
    where: { id: submissionId },
    select: {
      userId: true,
      problemVersionId: true,
      language: true,
      origin: true,
      verdict: true,
      cpuMs: true,
      maxMemoryKb: true,
      calibrationScore: true,
      timeComplexity: true,
    },
  });
  if (!mine || mine.origin !== "PRACTICE" || mine.verdict !== "AC") return null;
  if (mine.cpuMs === null || mine.maxMemoryKb === null) return null;
  if (mine.calibrationScore === null || !(mine.calibrationScore > 0)) return null;

  const rows = await db.$queryRaw<PeerRow[]>(Prisma.sql`
    SELECT DISTINCT ON ("userId")
           "cpuMs"::double precision * "calibrationScore" AS "timeScore",
           "maxMemoryKb" AS "memoryKb",
           "timeComplexity"::text AS "growth"
      FROM "public"."Submission"
     WHERE "problemVersionId" = ${mine.problemVersionId}
       AND "language" = ${mine.language}
       AND "origin" = 'PRACTICE'::"public"."SubmissionOrigin"
       AND "verdict" = 'AC'::"public"."Verdict"
       AND "userId" <> ${mine.userId}
       AND "cpuMs" IS NOT NULL
       AND "maxMemoryKb" IS NOT NULL
       AND "calibrationScore" IS NOT NULL
       AND "calibrationScore" > 0
     ORDER BY "userId", ("cpuMs"::double precision * "calibrationScore") ASC
  `);

  const calibration = mine.calibrationScore;
  const peers: PeerSolution[] = rows.map((row) => ({
    // Back onto the scale of the node that judged THIS submission.
    ms: row.timeScore / calibration,
    kb: row.memoryKb,
    growth: asClass(row.growth),
  }));

  return rankSolution({
    mine: { ms: mine.cpuMs, kb: mine.maxMemoryKb, growth: mine.timeComplexity },
    peers,
  });
}
