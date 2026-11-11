import "server-only";

import { markMcqs, type McqTotals } from "@recx/shared";
import type { AttemptLayout } from "@recx/shared";
import { db } from "@/lib/db";

/**
 * Mark one sitting's multiple-choice answers (Phase 12r).
 *
 * Computed on READ rather than stored on the attempt. There is no score
 * column to write and this slice does not add one: the inputs — the
 * layout's option order, the recorded answers and the stored correct
 * indexes — are all immutable once a sitting is under way, so marking is a
 * pure function of rows that cannot drift. A stored total would be a
 * second copy of something derivable, and the first thing to go stale when
 * an answer is corrected by hand.
 *
 * The totals ARE written once, into the submission audit row, which is a
 * different thing from a score: that records what was marked at the moment
 * the candidate handed in, so a result queried months later can be
 * compared with what the sitting said at the time.
 *
 * The correct index never leaves this module. It is selected here and
 * compared here; `ExamMcqView`, which is what a browser receives, has no
 * field for it.
 */
export async function markAttemptMcqs(args: {
  readonly attemptId: string;
  readonly layout: AttemptLayout;
}): Promise<McqTotals> {
  const laid = args.layout.mcqs ?? [];
  if (laid.length === 0) return markMcqs([]);

  const [rows, answers] = await Promise.all([
    db.assessmentMcq.findMany({
      where: { id: { in: laid.map((m) => m.mcqId) } },
      select: { id: true, correctIndex: true },
    }),
    db.assessmentMcqAnswer.findMany({
      where: { attemptId: args.attemptId },
      select: { mcqId: true, chosenIndex: true },
    }),
  ]);
  const correct = new Map(rows.map((row) => [row.id, row.correctIndex]));
  const chosen = new Map(answers.map((answer) => [answer.mcqId, answer.chosenIndex]));

  return markMcqs(
    laid.flatMap((mcq) => {
      const correctIndex = correct.get(mcq.mcqId);
      // A question in the layout whose row is gone cannot be marked either
      // way. Dropped rather than counted as blank, which would charge a
      // candidate for somebody else's deletion.
      if (correctIndex === undefined) return [];
      return [
        {
          mcqId: mcq.mcqId,
          points: mcq.points,
          optionOrder: mcq.optionOrder,
          correctIndex,
          chosenShownIndex: chosen.get(mcq.mcqId) ?? null,
        },
      ];
    }),
  );
}
