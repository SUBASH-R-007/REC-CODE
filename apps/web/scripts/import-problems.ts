/**
 * Bulk-import problems from a directory or a zip (package format 1,
 * docs/AUTHORING.md) — the same pipeline as /admin/problems/import.
 *
 *   cd apps/web
 *   npx tsx --conditions=react-server scripts/import-problems.ts <dir|file.zip> --as <collegeId>
 *
 *   --as <collegeId>  the ADMIN or SUPER_ADMIN account the import is recorded
 *                     under (ProblemImport.uploadedById, the drafts' creator)
 *
 * Each problem directory is imported in its own transaction and gets a
 * result row (CREATED / NEW_REVISION / UNCHANGED / FAILED with every issue
 * and the file it is about), so one bad entry never discards the batch.
 * Re-running the same import is safe: entries already imported come back
 * UNCHANGED. Validation is not started; use validate-and-publish.ts or the
 * "Validate imported drafts" button. Exits 1 when any entry failed.
 *
 * Audited as problem.import.started / problem.import.completed with
 * via "cli:<operator>". --conditions=react-server: see scripts/seed.ts.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USAGE =
  "Usage (from apps/web):\n" + "  npx tsx --conditions=react-server scripts/import-problems.ts <dir|file.zip> --as <collegeId>";

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

async function fileSha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  process.chdir(APP_ROOT);
  const envFile = path.join(APP_ROOT, ".env.local");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  requireReactServerCondition();
  if (!existsSync(args.source)) fail(`${args.source} does not exist.`);

  const [{ db }, { audit }, archiveModule, run] = await Promise.all([
    import("../src/lib/db"),
    import("../src/lib/audit"),
    import("../src/lib/authoring/import/archive"),
    import("../src/lib/authoring/import/run"),
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

  const stat = statSync(args.source);
  const isDir = stat.isDirectory();
  let archive;
  try {
    archive = isDir ? await archiveModule.openDirectoryArchive(args.source) : await archiveModule.openZipArchive(args.source);
  } catch (error) {
    if (error instanceof archiveModule.ArchiveError) fail(`Cannot import ${args.source}: ${error.message}`);
    throw error;
  }
  const record = await db.problemImport.create({
    data: {
      uploadedById: user.id,
      fileName: path.basename(args.source).slice(0, 200),
      sizeBytes: BigInt(isDir ? 0 : stat.size),
      archiveSha256: isDir ? createHash("sha256").update(`dir:${args.source}`).digest("hex") : await fileSha256(args.source),
      via,
    },
    select: { id: true },
  });
  await audit({
    actorId: user.id,
    action: "problem.import.started",
    entityType: "ProblemImport",
    entityId: record.id,
    sensitivity: "NORMAL",
    metadata: { entries: archive.entries.length, directory: isDir, via },
  });
  console.log(`import ${record.id}: ${archive.entries.length} problem director${archive.entries.length === 1 ? "y" : "ies"}`);
  for (const w of archive.warnings) console.log(`  warning: ${w.path}: ${w.message}`);

  const results = await run.runProblemImport(record.id, archive, user.id);
  await run.auditImportCompleted(record.id, { actorId: user.id, via }, results);
  let failed = 0;
  for (const r of results) {
    console.log(`  ${r.status.padEnd(12)} ${r.entry}${r.revision !== null ? ` (r${r.revision})` : ""}`);
    for (const e of r.errors) console.log(`      error: ${e.path ? `${e.path}: ` : ""}${e.message}`);
    for (const w of r.warnings) console.log(`      warning: ${w.path ? `${w.path}: ` : ""}${w.message}`);
    if (r.status === "FAILED") failed++;
  }
  const count = (s: string) => results.filter((r) => r.status === s).length;
  console.log(
    `import ${record.id}: ${count("CREATED")} created, ${count("NEW_REVISION")} new revisions, ` +
      `${count("UNCHANGED")} unchanged, ${failed} failed.`,
  );
  await db.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error("import-problems failed:", error);
  process.exit(1);
});
