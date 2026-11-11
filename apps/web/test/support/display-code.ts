import type { Db } from "@recx/db";

/**
 * A display code nobody is using (Phase 15l).
 *
 * `displayCodeSchema` is `REC-` and exactly four digits, so there are ten
 * thousand codes in all and `recx_test` holds a couple of hundred after
 * ordinary use. Every database suite that needed one used to guess:
 *
 *     displayCode: `REC-${Math.floor(1000 + Math.random() * 8999)}`
 *     displayCode: `REC-${(Date.now() % 9000) + 1000}`
 *
 * The first is a lottery with no retry — about one call in forty-five
 * collides once two hundred codes are resident — and the gate finally lost
 * it on 2026-11-07, failing `contest-entry` on a unique constraint that has
 * nothing to do with what that suite tests. The second is worse than a
 * lottery: two suites reaching it in the same second pick the same code
 * every time, which is not a probability but a schedule.
 *
 * So the code is ALLOCATED rather than guessed: read what is taken, then
 * walk from a random start until something is free. Random start, so that
 * suites which ever do run at the same time do not queue up on 1000;
 * `handedOut` as well as the database, so that two calls in one file cannot
 * return the same code before either row is inserted.
 *
 * The db project runs one file at a time (`apps/web/vitest.config.ts` says
 * why), which is what makes "read then insert" safe here. If that ever
 * changes, this becomes best-effort again — and the thing to do then is to
 * ask the database for the code, not to go back to guessing.
 */

const SPAN = 9_000;
const FIRST = 1_000;

/** Codes handed out in this process, inserted or not. */
const handedOut = new Set<string>();

export async function freeDisplayCode(db: Db): Promise<string> {
  const rows = await db.problem.findMany({
    where: { displayCode: { startsWith: "REC-" } },
    select: { displayCode: true },
  });
  const taken = new Set(rows.map((row) => row.displayCode));
  const start = Math.floor(Math.random() * SPAN);
  for (let i = 0; i < SPAN; i += 1) {
    // FIRST + n is always four digits, so there is nothing to pad.
    const code = `REC-${FIRST + ((start + i) % SPAN)}`;
    if (taken.has(code) || handedOut.has(code)) continue;
    handedOut.add(code);
    return code;
  }
  throw new Error(
    `recx_test has no free REC-NNNN display code: ${taken.size} are in use and ${handedOut.size} handed out this run. ` +
      "Drop and re-migrate the test database, or delete the problems a killed run left behind.",
  );
}
