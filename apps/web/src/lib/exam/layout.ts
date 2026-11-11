import "server-only";
import type { AssessmentAttempt } from "@recx/db";
import { parseAttemptLayout, type AttemptLayout } from "@recx/shared";

/**
 * Reading a stored paper back (Phase 6c).
 *
 * `AssessmentAttempt.layout` is jsonb, so it arrives as `unknown` and has to
 * be narrowed. It is also in the write-once tuple the
 * `AssessmentAttempt_machine` trigger protects, which means a layout that
 * does not parse is a database or migration fault rather than stale user
 * input — so this throws rather than returning an empty paper. Rendering a
 * blank exam to a candidate whose questions are unreadable would be far
 * worse than an error page an invigilator can act on.
 */
export function attemptLayoutOf(attempt: Pick<AssessmentAttempt, "id" | "layout">): AttemptLayout {
  try {
    return parseAttemptLayout(attempt.layout);
  } catch (cause) {
    throw new Error(
      `AssessmentAttempt ${attempt.id} has an unreadable layout: ${(cause as Error).message}`,
      { cause },
    );
  }
}
