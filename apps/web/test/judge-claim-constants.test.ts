import { describe, expect, it } from "vitest";
import { JUDGE_LEASE_SECONDS, JUDGE_RETRY } from "@recx/shared";

/**
 * The claim lease in src/lib/judge/claim.ts is written as literal SQL
 * ("interval '2 minutes'", "attemptCount" < 3). If either shared constant
 * changes, that SQL must change with it — this test is the reminder.
 */
describe("claim lease literals", () => {
  it("lease length is two minutes", () => {
    expect(JUDGE_LEASE_SECONDS).toBe(120);
  });

  it("infrastructure attempts are three", () => {
    expect(JUDGE_RETRY.attempts).toBe(3);
  });
});
