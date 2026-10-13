/**
 * Enforce that every APPROVED revision's reference solutions still get
 * their expected verdict on every test, in every enabled language — run it
 * after any toolchain, language or judge change (docs/RUNBOOK.md §2.10).
 *
 *   cd apps/web
 *   npx tsx --conditions=react-server scripts/check-approved.ts [--revoke] [--timeout-min=30]
 *   npx tsx --conditions=react-server scripts/check-approved.ts --repair-bundles
 *
 *   (default)         start a fresh validation round for every APPROVED
 *                     revision (status IN_REVIEW, approvedAt set), wait until
 *                     each settles, then list every revision whose reference
 *                     solutions do not all match. Exit 1 when any fails or
 *                     times out.
 *   --revoke          also revoke the approval of each failing revision
 *                     (problem.review.approval_revoked, APPROVED → IN_REVIEW)
 *   --timeout-min=N   how long to wait for the judges in total (default 30)
 *   --repair-bundles  instead: for every published revision whose bundle is
 *                     missing from the test-data store (a write that failed
 *                     after its publish committed), recompute the
 *                     deterministic bytes from the frozen tests and write
 *                     them. Exit 1 when any bundle cannot be repaired.
 *
 * APPROVED revisions live in the production database, so this is an
 * operator (or cron) command, not a CI job. A judge node serving the
 * REJUDGE lane must be up. Audited with via "cli:<operator>".
 * --conditions=react-server: see scripts/seed.ts.
 */
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USAGE =
  "Usage (from apps/web):\n" +
  "  npx tsx --conditions=react-server scripts/check-approved.ts [--revoke] [--timeout-min=30]\n" +
  "  npx tsx --conditions=react-server scripts/check-approved.ts --repair-bundles";

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

function parseArgs(argv: string[]): { revoke: boolean; repairBundles: boolean; timeoutMs: number } {
  let timeoutMin = 30;
  for (const flag of argv) {
    if (flag === "--revoke" || flag === "--repair-bundles") continue;
    const m = /^--timeout-min=(\d{1,3})$/.exec(flag);
    if (m && Number(m[1]) >= 1) timeoutMin = Number(m[1]);
    else fail(`Unknown option ${flag}.\n${USAGE}`);
  }
  const repairBundles = argv.includes("--repair-bundles");
  if (repairBundles && argv.includes("--revoke")) fail(`--repair-bundles runs on its own.\n${USAGE}`);
  return { revoke: argv.includes("--revoke"), repairBundles, timeoutMs: timeoutMin * 60_000 };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  process.chdir(APP_ROOT);
  const envFile = path.join(APP_ROOT, ".env.local");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  requireReactServerCondition();

  const [{ db }, validation, review, wait, { audit }] = await Promise.all([
    import("../src/lib/db"),
    import("../src/lib/judge/validation"),
    import("../src/lib/authoring/review"),
    import("../src/lib/authoring/validation-wait"),
    import("../src/lib/audit"),
  ]);
  let operator = "unknown";
  try {
    operator = os.userInfo().username;
  } catch {
    // No passwd entry for this uid (containers).
  }
  const via = `cli:${operator}`;

  if (args.repairBundles) {
    const published = await db.problemVersion.findMany({
      where: { frozenAt: { not: null }, bundleKey: { not: null } },
      orderBy: [{ problemId: "asc" }, { revision: "asc" }],
      select: { id: true, revision: true, problem: { select: { slug: true } } },
    });
    let bad = 0;
    for (const v of published) {
      try {
        const out = await validation.ensurePublishedBundle(v.id);
        if (out.status === "written") {
          console.log(`  written   ${v.problem.slug} r${v.revision}  ${out.bundleKey}`);
          await audit({
            actorId: null,
            action: "problem.bundle.repaired",
            entityType: "ProblemVersion",
            entityId: v.id,
            sensitivity: "SENSITIVE",
            metadata: { slug: v.problem.slug, revision: v.revision, bundleKey: out.bundleKey, via },
          });
        } else if (out.status === "mismatch") {
          bad++;
          console.error(`  MISMATCH  ${v.problem.slug} r${v.revision}: the frozen tests do not rebuild the pinned manifest.`);
        }
      } catch (error) {
        bad++;
        console.error(`  FAILED    ${v.problem.slug} r${v.revision}:`, error instanceof Error ? error.message : error);
      }
    }
    console.log(`check-approved --repair-bundles: ${published.length} published revision(s) checked, ${bad} problem(s).`);
    await db.$disconnect();
    process.exit(bad > 0 ? 1 : 0);
  }

  const approved = await db.problemVersion.findMany({
    where: { status: "IN_REVIEW", approvedAt: { not: null }, frozenAt: null },
    orderBy: [{ problemId: "asc" }, { revision: "asc" }],
    select: { id: true, revision: true, problem: { select: { slug: true } } },
  });
  console.log(`check-approved: ${approved.length} approved revision(s).`);
  const failures: { id: string; label: string; reasons: string[] }[] = [];
  const started: typeof approved = [];
  for (const v of approved) {
    const label = `${v.problem.slug} r${v.revision}`;
    try {
      const s = await validation.startValidation(v.id, { requestedById: null, via: `${via}:check-approved` });
      console.log(`  ${label}: ${s.runIds.length} model run(s) started`);
      for (const note of s.notes) console.log(`    note: ${note}`);
      started.push(v);
    } catch (error) {
      if (!(error instanceof validation.ValidationSetupError)) throw error;
      failures.push({ id: v.id, label, reasons: [error.message] });
    }
  }
  const deadline = Date.now() + args.timeoutMs;
  for (const v of started) {
    const label = `${v.problem.slug} r${v.revision}`;
    const { status, timedOut } = await wait.waitForValidation(v.id, { timeoutMs: Math.max(1_000, deadline - Date.now()) });
    if (timedOut) failures.push({ id: v.id, label, reasons: [`timed out in ${status.phase} (is a judge serving the REJUDGE lane?)`] });
    else if (!status.publishable) failures.push({ id: v.id, label, reasons: status.blockers });
    else console.log(`  ok        ${label}`);
  }
  for (const f of failures) {
    console.error(`  FAILED    ${f.label}`);
    for (const r of f.reasons) console.error(`    - ${r}`);
    if (args.revoke && !f.reasons.some((r) => r.startsWith("timed out"))) {
      try {
        await review.revokeApproval(
          { versionId: f.id, reason: `check-approved: ${f.reasons[0] ?? "reference solutions no longer match"}`.slice(0, 500) },
          { actorId: null, via },
        );
        console.error("    approval revoked");
      } catch (error) {
        console.error("    could not revoke:", error instanceof Error ? error.message : error);
      }
    }
  }
  console.log(`check-approved: ${approved.length - failures.length} ok, ${failures.length} failing.`);
  await db.$disconnect();
  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error("check-approved failed:", error);
  process.exit(1);
});
