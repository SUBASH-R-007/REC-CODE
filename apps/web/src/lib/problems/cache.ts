import "server-only";
import { revalidateTag } from "next/cache";

/**
 * The problem cache's key, its tag and its invalidation (Phase 10c).
 *
 * In `lib/` rather than in `server/queries/problems.ts` for a reason worth
 * stating: a module under `server/queries/` is swept by
 * `apps/web/test/student-exposure.db.test.ts`, which calls every export as a
 * student and asserts no canary comes back. A cache tag, a TTL and a key
 * builder are not queries and cannot leak anything, and registering them as
 * though they were would make that registry less meaningful, not more. The
 * writers that need to invalidate (`publishVersion`, `retireProblem`) import
 * from here too, and neither of them is a query module either.
 */

/** Cache tag of everything derived from the set of published problems. */
export const PROBLEMS_TAG = "problems";

/**
 * How long a stale LIVE POINTER can survive a writer that forgot to
 * revalidate. Not how long a statement is cached: the statement's key
 * contains the version, so it is never stale, only orphaned.
 */
export const PROBLEM_POINTER_TTL_SECONDS = 60;

/**
 * SPEC §10's cache key: `problem:{id}:v{statementVersion}`.
 *
 * The version is `Problem.version`, and the design's separate
 * `statementVersion` column was not added. `Problem.version` is already
 * incremented by exactly the two writes that can change what a student
 * reads — the publish flip and a retire — under the optimistic concurrency
 * those writes already use, and the statement itself lives on a
 * `ProblemVersion` that is frozen at publish and can never be edited in
 * place. A second counter would have to be kept in step with the first, and
 * the failure mode of getting that wrong is precisely the bug this key
 * exists to eliminate: a student reading an old statement.
 *
 * `tests/repo/cache-keys.test.ts` asserts the version is in it — a key
 * without the version is a cache nobody can invalidate.
 */
export function problemCacheKey(problemId: string, version: number): string {
  return `problem:${problemId}:v${version}`;
}

/**
 * Call after any write that changes which problems are published, or which
 * version of one is live: a publish, a retire.
 *
 * Best effort, and deliberately so. The write has committed and been audited
 * by the time this runs, so a failed revalidation must not be reported as a
 * failed publish — and `revalidateTag` throws outside a request, which is
 * exactly where the CSV import path runs. The pointer TTL is the backstop:
 * without this call the change is visible within a minute, with it at once.
 */
export function revalidateProblems(): void {
  try {
    revalidateTag(PROBLEMS_TAG);
  } catch (error) {
    console.warn("[problems] could not revalidate the problem cache:", error instanceof Error ? error.message : error);
  }
}
