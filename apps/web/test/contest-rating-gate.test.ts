import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The gate on releasing a contest rating (Phase 12x).
 *
 * `releaseContestRating` refused anything whose `Contest.status` was not
 * `FINISHED` — a state nothing in the product has ever written.
 * `publishContest` sets PUBLISHED and there a contest stays; every student
 * page derives upcoming / running / finished from `startsAt` and `endsAt`.
 * So no contest could be rated, ever, and the gate below it ("the standings
 * have not been ranked yet") could not be satisfied either, because the
 * rank job was looking for the same state.
 *
 * Asserted against the SOURCE, and the reason is worth stating plainly: the
 * action takes a super-admin session, a row lock and a field of at least
 * ten rated participants with ranks on them, so driving it needs most of a
 * contest. The database-level behaviour it protects — a rating written once
 * and never rewritten — is covered by `contest-invariants.db.test.ts`. What
 * can be answered here, and is the thing that was wrong, is which question
 * the gate asks.
 *
 * Mutation check is built in: the first assertion fails if the old
 * comparison comes back, and the second fails if the clock check goes away,
 * so neither half can quietly rot into a test that cannot fail.
 */

const SOURCE = readFileSync(
  path.join(
    path.dirname(path.dirname(fileURLToPath(import.meta.url))),
    "src",
    "server",
    "actions",
    "super-ratings.ts",
  ),
  "utf8",
);

describe("releasing a contest rating", () => {
  it("does not require a status nothing writes", () => {
    expect(SOURCE, 'the FINISHED gate is back; nothing sets Contest.status to FINISHED').not.toMatch(
      /contest\.status\s*!==\s*"FINISHED"/,
    );
    expect(SOURCE).not.toMatch(/contest\.status\s*===\s*"RUNNING"/);
  });

  it("asks the clock whether the contest has finished", () => {
    expect(SOURCE, "the window is the gate now").toMatch(/contest\.endsAt\.getTime\(\)\s*>\s*Date\.now\(\)/);
  });

  it("still refuses a contest that is not a published one", () => {
    // A cancelled contest's board is not a result, and a draft has none.
    expect(SOURCE).toMatch(/contest\.status === "CANCELLED" \|\| contest\.status === "DRAFT"/);
  });

  it("still refuses to rate twice, and still refuses an unrated contest", () => {
    // The two gates that were already right, kept honest while the one
    // beside them changed.
    expect(SOURCE).toMatch(/ratingComputedAt !== null/);
    expect(SOURCE).toMatch(/!contest\.isRated/);
  });
});
