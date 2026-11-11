import { describe, expect, it } from "vitest";
import { findFiles, readRepoFile } from "./support/repo";

/**
 * Every route under a sitting goes through the attempt guard (Phase 12s).
 *
 * `guardAttempt` is not a convenience. It is the one place that checks a
 * sitting is live, that this session is the session that started it, that
 * the attempt token matches — and, through `checkContainment`, that the
 * request is still inside the hall's CIDR allowlist and still carrying a
 * valid Safe Exam Browser key. `docs/PROCTORING.md` §4 lists those last two
 * as controls that *actually enforce*, and the claim it makes for them is
 * "re-verified on every heartbeat". That claim is only true for as long as
 * every route a sitting talks to asks the guard.
 *
 * A new route is exactly how that would stop being true, and quietly: it
 * would work perfectly in a tab on a developer's laptop. Phase 12q.5 added
 * `run` and 12r added `mcq` to this directory, and both had to be written
 * with the guard in them for the right reason rather than because anything
 * checked. Now something checks.
 *
 * Scope is `[attemptId]/` and nothing else, which is the whole of "a route
 * under a sitting". `start` cannot ask the guard — it is the route that
 * CREATES the attempt, so there is nothing to guard yet, and it carries its
 * own containment check instead, which this file asserts so the exemption
 * does not become a hole. `device/enrol` and `device/assert` are not under
 * a sitting at all: enrolment is a supervisor's errand and an assertion
 * happens on the readiness page before an attempt exists. Writing the fence
 * over every file under `api/exam/` flagged both of those, which is how the
 * scope got stated properly rather than loosely.
 */

const UNDER_A_SITTING = "apps/web/src/app/api/exam/[attemptId]/";
/** The route that creates a sitting, and so cannot guard one. */
const CREATES_THE_ATTEMPT = "apps/web/src/app/api/exam/start/[slug]/route.ts";

function examRoutes(): string[] {
  return findFiles({ extensions: [".ts"] }).filter(
    (rel) => rel.startsWith(UNDER_A_SITTING) && rel.endsWith("/route.ts"),
  );
}

describe("the routes a sitting talks to", () => {
  it("are all found, so this fence is not passing on an empty list", () => {
    const routes = examRoutes();
    expect(routes.length, "no routes found under a sitting — has the directory moved?").toBeGreaterThanOrEqual(5);
    // The ones that exist today, so a rename is noticed rather than silently
    // dropping a route out of this fence's reach.
    for (const expected of ["hb", "events", "snapshot", "submit", "run", "mcq"]) {
      expect(
        routes.some((rel) => rel.includes(`/${expected}/`)),
        `${expected} route is missing from ${UNDER_A_SITTING}`,
      ).toBe(true);
    }
  });

  it("each ask guardAttempt, so containment is re-checked on every one", () => {
    const offenders = examRoutes().filter((rel) => !readRepoFile(rel).includes("guardAttempt("));
    expect(
      offenders,
      "a route under a sitting that does not call guardAttempt skips the CIDR allowlist and the SEB key (docs/PROCTORING.md §4)",
    ).toEqual([]);
  });

  it("each end the attempt session when the guard refuses, rather than just answering", () => {
    // A refused request means this client has no live sitting. Leaving the
    // session open invites it to keep trying, and the revoke reason is what
    // the client renders to say why it stopped.
    const offenders = examRoutes().filter((rel) => {
      const source = readRepoFile(rel);
      return !source.includes("endAttemptSession(") || !source.includes("revokeReason");
    });
    expect(offenders, "a guarded route should end the session and name the revoke reason").toEqual([]);
  });

  it("and the route that creates a sitting checks containment itself", () => {
    // The exemption above is only safe because of this.
    const start = readRepoFile(CREATES_THE_ATTEMPT);
    expect(start, "start should go through the exam start library").toContain("startOrResumeAttempt");
    expect(
      readRepoFile("apps/web/src/lib/exam/start.ts"),
      "startAttempt must check containment, since its route cannot guard an attempt that does not exist yet",
    ).toContain("checkContainment(");
  });

  it("and the sitting it creates is linked to its hall, or the allowlist checks nothing", () => {
    /**
     * The defect this fence exists for, because it survived everything else
     * (Phase 12s). `checkContainment` compares the candidate's address
     * against the hall's CIDR blocks only when the attempt carries an
     * `examSessionId` — correctly, since an unseated candidate has no hall
     * to be inside. Nothing in the application ever wrote that column, so
     * every attempt row carried null and the allowlist was re-verified
     * against nothing on every heartbeat of every sitting.
     *
     * `exam-start-hall.db.test.ts` proves it against a real database and is
     * the stronger test, but it is opt-in (`RECX_DB_TESTS=1`) and so does
     * not run in the default gate. This line does.
     */
    expect(
      readRepoFile("apps/web/src/lib/exam/start.ts"),
      "the created sitting must record its exam session, or docs/PROCTORING.md §4's allowlist never applies",
    ).toContain("examSessionId: hall?.id ?? null");
    expect(
      readRepoFile("apps/web/src/lib/exam/containment.ts"),
      "the allowlist is still gated on the attempt's exam session, which is what makes the line above load-bearing",
    ).toContain('args.attempt.examSessionId !== null');
  });
});
