/**
 * Import the authored aptitude bank — the same pipeline as
 * `/admin/aptitude/import` (Phase 16k, `docs/ROADMAP.md` §1.2).
 *
 *   cd apps/web
 *   npx tsx --conditions=react-server scripts/import-aptitude.ts content/aptitude --as <collegeId>
 *
 *   --as <collegeId>  the ADMIN or SUPER_ADMIN the import is recorded under
 *                     (AptitudeImport.uploadedById)
 *
 * A file or a directory of `.csv` files. Each file is its own import, and
 * each ROW is its own transaction, so one bad row never discards the rest —
 * which is SPEC §5's requirement and the reason the import surface exists
 * rather than a seed.
 *
 * Questions arrive as **DRAFT**. Nothing here publishes them, and nothing
 * here could: `publishAptitudeQuestion` refuses the author, because a worked
 * explanation nobody else has read is a worked explanation nobody has
 * checked. Review and publish at `/admin/aptitude`.
 *
 * Re-running is safe. The importer's duplicate detector keys on a hash of
 * the normalised stem, options and answer — excluding the explanation, so
 * improving the working is not a new question.
 *
 * Audited as `aptitude.import.*` with via "cli:<operator>"; the `via` column
 * accepts only "upload" or "cli:…", which is why this is a script and not a
 * test helper. --conditions=react-server: see scripts/seed.ts.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USAGE =
  "Usage (from apps/web):\n" +
  "  npx tsx --conditions=react-server scripts/import-aptitude.ts <dir|file.csv> --as <collegeId>";

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

function parseArgs(argv: string[]): { source: string; as: string } {
  const asAt = argv.indexOf("--as");
  const as = asAt >= 0 ? argv[asAt + 1] : undefined;
  const rest = argv.filter((_a, i) => i !== asAt && i !== asAt + 1);
  if (!as || rest.length !== 1 || rest[0]!.startsWith("--")) fail(USAGE);
  return { source: path.resolve(rest[0]!), as: as.trim() };
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

  const [{ db }, { runAptitudeImport }] = await Promise.all([
    import("../src/lib/db"),
    import("../src/lib/aptitude/import"),
  ]);

  let operator = "unknown";
  try {
    operator = os.userInfo().username;
  } catch {
    // No passwd entry for this uid (containers).
  }
  const via = `cli:${operator}`;

  const user = await db.user.findUnique({ where: { collegeId: args.as }, select: { id: true, role: true } });
  if (!user || (user.role !== "ADMIN" && user.role !== "SUPER_ADMIN")) {
    fail(`--as must name an ADMIN or SUPER_ADMIN account (${args.as} is not one).`);
  }

  const files = filesOf(args.source);
  console.log(`${files.length} file${files.length === 1 ? "" : "s"}, as ${args.as}, via ${via}`);

  let created = 0;
  let unchanged = 0;
  let failed = 0;
  for (const file of files) {
    const name = path.basename(file);
    const outcome = await runAptitudeImport({
      text: readFileSync(file, "utf8"),
      fileName: name.slice(0, 200),
      uploadedById: user.id,
      via,
      // Both null: every row in these files names its own topic, and the
      // area follows from it. A default would quietly rescue a row that
      // forgot, which is the opposite of what per-row results are for.
      defaultArea: null,
      defaultTopic: null,
      sourceBatch: `cli:${name.replace(/\.csv$/i, "")}`,
    });
    created += outcome.created;
    unchanged += outcome.unchanged;
    failed += outcome.failed;
    console.log(
      `  ${name}: ${outcome.status} - ${outcome.created} created, ${outcome.revised} revised, ` +
        `${outcome.unchanged} unchanged, ${outcome.failed} failed`,
    );
    if (outcome.error) console.log(`    the whole file was refused: ${outcome.error}`);
    if (outcome.failed > 0) {
      // The per-row reasons live on AptitudeImportRow, which is where the
      // admin page reads them from too -- printing them here means a CLI
      // operator does not have to open a browser to find out which line.
      const rows = await db.aptitudeImportRow.findMany({
        where: { importId: outcome.importId, status: "FAILED" },
        orderBy: { line: "asc" },
        select: { line: true, errors: true },
      });
      for (const row of rows) {
        // `errors` is Json: [{path, message}] as the importer writes it,
        // read defensively because a column that can hold anything
        // eventually does.
        const messages = Array.isArray(row.errors)
          ? row.errors.map((entry) =>
              typeof entry === "object" && entry !== null && "message" in entry
                ? String((entry as { message: unknown }).message)
                : String(entry),
            )
          : [String(row.errors)];
        console.log(`    line ${row.line}: ${messages.join("; ")}`);
      }
    }
  }

  console.log(`total: ${created} created, ${unchanged} unchanged, ${failed} failed`);
  if (failed > 0) {
    console.error("Some rows failed. Nothing else was discarded; fix those lines and re-run.");
    process.exit(1);
  }
  console.log("All rows imported as DRAFT. Review and publish at /admin/aptitude - the author cannot publish their own.");
}

await main();
