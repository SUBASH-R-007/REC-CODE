/**
 * Import the pre-launch interview archive (Phase 16q, `docs/ROADMAP.md`
 * §1.7).
 *
 *   cd apps/web
 *   npx tsx --conditions=react-server scripts/import-experiences.ts <dir|file.csv> --as <collegeId>
 *
 *   --as <collegeId>  the ADMIN or SUPER_ADMIN the import is audited to
 *   --dry-run         read, validate and report; write nothing
 *
 * SPEC §11 asks for a one-time structured collection from the two most
 * recent graduated batches before launch, and §1.7 said "the software is
 * ready for it". **It was not.** `InterviewSource.BOOTSTRAP` existed, the
 * CHECK `InterviewExperience_author_check` allowed a row with no author
 * precisely so a bootstrap row could have none, a query knew how to label
 * one — and nothing in the product wrote one. The archive's only write path
 * is the student's own form. So the placement cell could run the survey and
 * then had nowhere to put it.
 *
 * **Why a script and not a page.** The bootstrap is one act, before launch,
 * by a member of staff. An upload page would be a surface to keep, test,
 * scan for accessibility and reason about in the capability matrix forever,
 * for a job that happens once — and `AptitudeImport.via` already
 * establishes `cli:<operator>` as this repository's answer to "a one-time
 * import by somebody with a shell".
 *
 * Every row arrives **PENDING**. §1.7's "done when" has two halves —
 * collected, and *"the moderation queue has been worked through once"* —
 * and an import that approved its own rows would quietly delete the second
 * one. Nothing here can approve anything.
 *
 * Each row is its own transaction, so a bad row on line 180 never discards
 * the 179 before it; re-running is safe, because a row already in the
 * archive is reported as a duplicate rather than inserted again
 * (`bootstrapRowKey`). --conditions=react-server: see scripts/seed.ts.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USAGE =
  "Usage (from apps/web):\n" +
  "  npx tsx --conditions=react-server scripts/import-experiences.ts <dir|file.csv> --as <collegeId> [--dry-run]";

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

function parseArgs(argv: string[]): { source: string; as: string; dryRun: boolean } {
  const dryRun = argv.includes("--dry-run");
  const rest0 = argv.filter((a) => a !== "--dry-run");
  const asAt = rest0.indexOf("--as");
  const as = asAt >= 0 ? rest0[asAt + 1] : undefined;
  const rest = rest0.filter((_a, i) => i !== asAt && i !== asAt + 1);
  if (!as || rest.length !== 1 || rest[0]!.startsWith("--")) fail(USAGE);
  return { source: path.resolve(rest[0]!), as: as.trim(), dryRun };
}

/** The files to import: one, or every `.csv` in a directory, in name order. */
function filesOf(source: string): string[] {
  if (!statSync(source).isDirectory()) return [source];
  const found = readdirSync(source)
    .filter((name) => name.toLowerCase().endsWith(".csv"))
    .sort()
    .map((name) => path.join(source, name));
  if (found.length === 0) fail(`${source} holds no .csv files.`);
  return found;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  process.chdir(APP_ROOT);
  const envFile = path.join(APP_ROOT, ".env.local");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  requireReactServerCondition();
  if (!existsSync(args.source)) fail(`${args.source} does not exist.`);

  const [shared, { db }, { bootstrapExperience, bootstrapOperator }] = await Promise.all([
    import("@recx/shared"),
    import("../src/lib/db"),
    import("../src/lib/interviews/bootstrap"),
  ]);
  const { INTERVIEW_BOOTSTRAP_CSV_SHAPE, bootstrapRowFrom, campusDay, parseCsvRecords } = shared;

  const operator = await bootstrapOperator(args.as).catch((error: unknown) => {
    fail(error instanceof Error ? error.message : String(error));
  });

  // The campus year, so "this year" means the same thing here as it does
  // to `submitExperienceFor`, which reads it in Asia/Kolkata.
  const nowYear = Number(campusDay(new Date()).slice(0, 4));
  const files = filesOf(args.source);
  console.log(
    `${files.length} file${files.length === 1 ? "" : "s"}, as ${operator.collegeId}` +
      `${args.dryRun ? " (dry run: nothing is written)" : ""}`,
  );

  let created = 0;
  let duplicate = 0;
  let refused = 0;

  for (const file of files) {
    const name = path.basename(file);
    const parsed = parseCsvRecords(readFileSync(file, "utf8"), INTERVIEW_BOOTSTRAP_CSV_SHAPE);
    if (parsed.errors.length > 0) {
      // A file-level problem is the whole file's problem: a missing column
      // would make every row wrong in the same way.
      console.log(`  ${name}: REFUSED`);
      for (const issue of parsed.errors) console.log(`    line ${issue.line}: ${issue.message}`);
      refused += parsed.rows.length;
      continue;
    }

    console.log(`  ${name}: ${parsed.rows.length} row${parsed.rows.length === 1 ? "" : "s"}`);
    for (const record of parsed.rows) {
      const read = bootstrapRowFrom(record.cells, nowYear);
      if (read.row === null) {
        refused += 1;
        console.log(`    line ${record.line}: REFUSED`);
        for (const issue of read.issues) console.log(`      ${issue}`);
        continue;
      }
      if (args.dryRun) {
        created += 1;
        console.log(`    line ${record.line}: would import ${read.row.companyName} (${read.row.role})`);
        continue;
      }
      const outcome = await bootstrapExperience({ operatorId: operator.id, row: read.row, nowYear });
      if (outcome.id) {
        created += 1;
      } else if (outcome.duplicateOf) {
        duplicate += 1;
        console.log(`    line ${record.line}: already in the archive (${outcome.duplicateOf})`);
      } else {
        refused += 1;
        console.log(`    line ${record.line}: REFUSED — ${outcome.refusal ?? "unknown"}`);
      }
    }
  }

  console.log(
    `\n${created} ${args.dryRun ? "would be imported" : "imported"}, ` +
      `${duplicate} already there, ${refused} refused.`,
  );
  if (!args.dryRun && created > 0) {
    console.log("Every row is PENDING. Work the queue at /mentor/experiences — nothing here approves anything.");
  }
  await db.$disconnect();
  // A refused row is an operator's to fix, and a zero exit would hide it.
  if (refused > 0) process.exit(1);
}

await main();
