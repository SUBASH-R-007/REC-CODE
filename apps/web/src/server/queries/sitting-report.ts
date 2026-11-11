import "server-only";
import { db } from "@/lib/db";

/**
 * A student's own report on their own sitting (Phase 6e).
 *
 * In its own module, away from the reviewers' queries, for the reason the
 * appeal action is: `tests/repo/admin-scope.test.ts` treats any file that
 * calls a guard and mentions ADMIN as admin code, and then wants every
 * student query in it shaped with `scopedStudentWhere`. That is the wrong
 * tool here — this query is scoped by `userId`, the student's own, which is
 * stronger than any department grant — and splitting the file makes that
 * visible rather than burying it in an exemption.
 *
 * What is NOT in here, by SPEC section 5: a band, a points total, an
 * "integrity score". "Never display a band or an 'integrity score' to
 * students or recruiters — it invites exactly the misreading we are
 * preventing, and penalises the honest student with the bad laptop while the
 * competent cheater scores a clean 0."
 */

/**
 * What a STUDENT is shown about their own sitting.
 *
 * No band. No points. No "integrity score". SPEC §5 forbids all three, and
 * `tests/repo/integrity-isolation.test.ts` scans the student tree to make
 * sure none of them leaks in later.
 *
 * What they DO get: what was recorded about them in plain words, the verdict,
 * the reviewer's written rationale, and whether they can still appeal. SPEC
 * §5 wants the report available "within 48h", and this is readable the moment
 * the flag exists — a student should not have to wait to find out their
 * result is withheld.
 */
export interface StudentReport {
  readonly attemptId: string;
  /** The flag, when there is one, so the appeal form can name it. An id, not a band. */
  readonly flagId: string | null;
  readonly assessmentTitle: string;
  readonly submittedAt: Date | null;
  /** True while the result is off the public leaderboard. */
  readonly withheld: boolean;
  readonly resolved: boolean;
  /** "Under review", "Cleared", "Upheld", "Cleared automatically", "Overturned". */
  readonly state: string;
  /** What was recorded, in the student's own words. Counts, no scoring. */
  readonly recorded: readonly string[];
  readonly verdicts: ReadonlyArray<{ readonly verdict: string; readonly rationale: string; readonly decidedAt: Date }>;
  readonly reviewDeadline: Date;
  /** Can they still appeal? 7 days from an UPHELD decision. */
  readonly canAppeal: boolean;
  readonly appeal: {
    readonly submittedAt: Date;
    readonly decideBy: Date;
    readonly outcome: string;
  } | null;
}

const STATE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  OPEN: "Under review",
  CLEARED: "Cleared",
  UPHELD: "Upheld",
  AUTO_CLEARED: "Cleared automatically — nobody reviewed it within the deadline",
  OVERTURNED: "Overturned on appeal",
});

export async function getStudentReport(args: {
  readonly attemptId: string;
  readonly userId: string;
}): Promise<StudentReport | null> {
  const attempt = await db.assessmentAttempt.findFirst({
    // The student's OWN sitting only.
    where: { id: args.attemptId, userId: args.userId },
    select: {
      id: true,
      submittedAt: true,
      blurEventCount: true,
      fullscreenExitCount: true,
      pasteEventCount: true,
      maxHeartbeatGapSeconds: true,
      assessment: { select: { title: true } },
      integrityFlag: {
        select: {
          id: true,
          status: true,
          withheld: true,
          reviewDeadline: true,
          reviews: { orderBy: { decidedAt: "asc" }, select: { verdict: true, rationale: true, decidedAt: true } },
          appeals: {
            orderBy: { submittedAt: "desc" },
            take: 1,
            select: { submittedAt: true, decideBy: true, outcome: true },
          },
        },
      },
    },
  });
  if (!attempt) return null;

  const recorded: string[] = [];
  if (attempt.blurEventCount > 0) {
    recorded.push(`The exam window lost focus ${attempt.blurEventCount} time(s).`);
  }
  if (attempt.fullscreenExitCount > 0) {
    recorded.push(`Full screen was left ${attempt.fullscreenExitCount} time(s).`);
  }
  if (attempt.pasteEventCount > 0) {
    recorded.push(`${attempt.pasteEventCount} paste(s) were recorded, with their size and a one-way fingerprint — never the text.`);
  }
  if (attempt.maxHeartbeatGapSeconds >= 45) {
    recorded.push(
      `Your connection was lost for up to ${Math.round(attempt.maxHeartbeatGapSeconds / 60)} minute(s). A dropped connection is not held against you.`,
    );
  }
  if (recorded.length === 0) recorded.push("Nothing unusual was recorded during your sitting.");

  const flag = attempt.integrityFlag;
  if (!flag) {
    return {
      attemptId: attempt.id,
      flagId: null,
      assessmentTitle: attempt.assessment.title,
      submittedAt: attempt.submittedAt,
      withheld: false,
      resolved: true,
      state: "No review needed",
      recorded,
      verdicts: [],
      reviewDeadline: attempt.submittedAt ?? new Date(),
      canAppeal: false,
      appeal: null,
    };
  }

  const appeal = flag.appeals[0] ?? null;
  return {
    attemptId: attempt.id,
    flagId: flag.id,
    assessmentTitle: attempt.assessment.title,
    submittedAt: attempt.submittedAt,
    withheld: flag.withheld,
    resolved: flag.status !== "OPEN",
    state: STATE_WORDS[flag.status] ?? flag.status,
    recorded,
    verdicts: flag.reviews,
    reviewDeadline: flag.reviewDeadline,
    // Only an upheld decision is appealable, and only once.
    canAppeal: flag.status === "UPHELD" && appeal === null,
    appeal,
  };
}
