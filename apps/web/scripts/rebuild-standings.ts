/**
 * Rebuild a contest's standings from ContestProblemAttempt.
 *
 *   cd apps/web
 *   npx tsx --conditions=react-server scripts/rebuild-standings.ts <contestId|slug> [--check]
 *
 *   --check   compare only: report whether the stored board already equals
 *             the rebuild, change nothing, and exit 1 if it differs.
 *
 * Why this exists (SPEC §4e, §5): ContestProblemAttempt is AUTHORITATIVE and
 * ContestStanding is a materialised view of it. Redis holds the live board
 * for speed, so a Redis flush must cost warm cache and nothing else. This
 * command is the proof — "rebuild-standings reproduces a standings table
 * from ContestProblemAttempt byte-for-byte after a simulated Redis flush" is
 * a Phase 5 gate item, and it is shipped before the first real contest, not
 * written during an incident.
 *
 * It is also the repair tool: if the rank job ever wrote a wrong board, this
 * recomputes it from rows no live path may rewrite.
 *
 * --conditions=react-server: see scripts/seed.ts.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USAGE =
  "Usage (from apps/web):\n" +
  "  npx tsx --conditions=react-server scripts/rebuild-standings.ts <contestId|slug> [--check]";

function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

function requireReactServerCondition() {
  let resolved = "";
  try {
    resolved = import.meta.resolve("server-only");
  } catch {
    fail("Cannot resolve the server-only package. Run `npx pnpm@9.15.9 install` first.");
  }
  if (!resolved.endsWith("/empty.js")) fail(`This script needs the react-server condition.\n${USAGE}`);
}

async function main() {
  requireReactServerCondition();
  process.chdir(APP_ROOT);

  const argv = process.argv.slice(2);
  const check = argv.includes("--check");
  const positional = argv.filter((a) => !a.startsWith("--"));
  const target = positional[0];
  if (!target || positional.length > 1) fail(USAGE);

  const { db } = await import("../src/lib/db");
  const { computeStandings, snapshotOf, storedSnapshot, writeStandings } = await import(
    "../src/lib/contests/standings"
  );

  const contest = await db.contest.findFirst({
    where: { OR: [{ id: target }, { slug: target }] },
    select: { id: true, slug: true, title: true, kind: true, status: true },
  });
  if (!contest) fail(`No contest with id or slug ${JSON.stringify(target)}.`);

  const rebuilt = await computeStandings(db, contest.id, contest.kind);
  const before = await storedSnapshot(db, contest.id);
  const after = snapshotOf(rebuilt);
  const identical = JSON.stringify(before) === JSON.stringify(after);

  console.log(`${contest.slug} (${contest.kind}, ${contest.status})`);
  console.log(`  attempts rebuild to ${rebuilt.length} participant(s); stored board holds ${before.length}`);

  if (check) {
    if (identical) {
      console.log("  --check: the stored board already equals the rebuild.");
      return;
    }
    console.error("  --check: the stored board DIFFERS from the rebuild.");
    const byUser = new Map(before.map((r) => [r.userId, r]));
    for (const row of after) {
      const was = byUser.get(row.userId);
      if (!was) {
        console.error(`    + ${row.userId} rank ${row.rank} score ${row.score} penalty ${row.penalty}`);
      } else if (JSON.stringify(was) !== JSON.stringify(row)) {
        console.error(
          `    ~ ${row.userId} rank ${was.rank}->${row.rank} score ${was.score}->${row.score} penalty ${was.penalty}->${row.penalty}`,
        );
      }
    }
    const keep = new Set(after.map((r) => r.userId));
    for (const row of before) if (!keep.has(row.userId)) console.error(`    - ${row.userId} (no attempts)`);
    process.exit(1);
  }

  const written = await db.$transaction(async (tx) => writeStandings(tx, contest.id, rebuilt));
  console.log(`  wrote ${written.written} row(s), removed ${written.removed}`);
  console.log(identical ? "  the board was already correct." : "  the board was rebuilt.");
}

main()
  .then(async () => {
    const { db } = await import("../src/lib/db");
    await db.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    try {
      const { db } = await import("../src/lib/db");
      await db.$disconnect();
    } catch {
      /* already down */
    }
    process.exit(1);
  });
