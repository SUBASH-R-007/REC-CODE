/**
 * Validate a problem's DRAFT revision on the judge fleet, then publish it.
 *
 *   cd apps/web
 *   npx tsx --conditions=react-server scripts/validate-and-publish.ts <slug> [--new-revision] [--restart] [--approve] [--timeout-min=10]
 *
 *   --new-revision   clone the live version into a new DRAFT revision first
 *                    (every child: tests by blob reference, subtasks,
 *                    reference solutions, starter code, hints, editorial,
 *                    checker; topic tags stay on the problem)
 *   --restart        start a fresh validation round even if one is running
 *   --approve        operator approval: submit the draft for review (the
 *                    operator attests the content is originally authored)
 *                    and approve it, recorded with approvedById null and
 *                    via "cli:<operator>". Without it an unapproved revision
 *                    is validated but publishing is blocked until a second
 *                    admin approves it in /admin/problems.
 *   --timeout-min=N  how long to wait for the judges (default 10)
 *
 * Validation (src/lib/judge/validation.ts) runs every model solution at the
 * CPU ceiling to measure it, derives per-language limits, then proves every
 * deliberately-wrong solution fails at those limits. A judge node must be
 * up (the jobs go to the REJUDGE lane). The script waits by polling the
 * database, then publishes — or prints why publishing is blocked and exits 1.
 * If it times out, validation carries on in the background; run the script
 * again to pick up where it is.
 *
 * After a successful publish the seeded study plans (scripts/content/
 * study-plans.ts) are brought in step, so a newly published problem joins
 * them and their itemsTotal stays correct. Other plans are never touched.
 *
 * Every step is audited (actor: none, via "cli:<operator>").
 * --conditions=react-server: see scripts/seed.ts.
 */
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USAGE =
  "Usage (from apps/web):\n" +
  "  npx tsx --conditions=react-server scripts/validate-and-publish.ts <slug> [--new-revision] [--restart] [--approve] [--timeout-min=10]";

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

interface Args {
  slug: string;
  newRevision: boolean;
  restart: boolean;
  approve: boolean;
  timeoutMs: number;
}

const FLAGS = new Set(["--new-revision", "--restart", "--approve"]);

function parseArgs(argv: string[]): Args {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const flags = argv.filter((a) => a.startsWith("--"));
  const slug = positional[0];
  if (!slug || positional.length > 1 || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) fail(USAGE);
  let timeoutMin = 10;
  for (const flag of flags) {
    if (FLAGS.has(flag)) continue;
    const m = /^--timeout-min=(\d{1,3})$/.exec(flag);
    if (m && Number(m[1]) >= 1) timeoutMin = Number(m[1]);
    else fail(`Unknown option ${flag}.\n${USAGE}`);
  }
  return {
    slug,
    newRevision: flags.includes("--new-revision"),
    restart: flags.includes("--restart"),
    approve: flags.includes("--approve"),
    timeoutMs: timeoutMin * 60_000,
  };
}

async function main() {
  process.chdir(APP_ROOT);
  const envFile = path.join(APP_ROOT, ".env.local");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  requireReactServerCondition();
  const args = parseArgs(process.argv.slice(2));

  const [{ db }, validation, review, wait, errors] = await Promise.all([
    import("../src/lib/db"),
    import("../src/lib/judge/validation"),
    import("../src/lib/authoring/review"),
    import("../src/lib/authoring/validation-wait"),
    import("../src/lib/errors"),
  ]);
  let operator = "unknown";
  try {
    operator = os.userInfo().username;
  } catch {
    // No passwd entry for this uid (containers); the audit rows still record the action.
  }
  const via = `cli:${operator}`;

  const problem = await db.problem.findUnique({
    where: { slug: args.slug },
    select: {
      id: true,
      liveVersionId: true,
      versions: { orderBy: { revision: "desc" }, select: { id: true, revision: true, frozenAt: true } },
    },
  });
  if (!problem) fail(`No problem with slug ${args.slug}.`);

  let draft = problem.versions.find((v) => v.frozenAt === null) ?? null;
  if (args.newRevision) {
    if (draft) fail(`Revision ${draft.revision} of ${args.slug} is already a draft. Run without --new-revision.`);
    if (!problem.liveVersionId) fail(`${args.slug} has no live version to clone.`);
    const created = await validation.cloneVersionAsDraft(problem.liveVersionId, { createdById: null, via, refuseIfDraftExists: true });
    console.log(`${args.slug}: created draft revision ${created.revision} from the live version.`);
    draft = { id: created.versionId, revision: created.revision, frozenAt: null };
  }
  if (!draft) fail(`${args.slug} has no draft revision. Pass --new-revision to clone the live one.`);
  const versionId = draft.id;
  const head = await db.problemVersion.findUniqueOrThrow({
    where: { id: versionId },
    select: { ioMode: true, _count: { select: { hints: true } }, editorial: { select: { id: true } } },
  });
  console.log(
    `${args.slug} r${draft.revision}: ${head.ioMode} mode, ${head._count.hints} hint tier(s), ` +
      `${head.editorial ? "an editorial" : "no editorial"}.`,
  );

  let status = await validation.getValidationStatus(versionId);
  const running = status.phase === "STAGE1_RUNNING" || status.phase === "STAGE2_RUNNING" || status.phase === "STAGE2_NEEDED";
  if (args.restart || status.phase === "NOT_STARTED" || status.phase === "STAGE1_FAILED" || (status.phase === "COMPLETE" && !status.publishable)) {
    try {
      const started = await validation.startValidation(versionId, { requestedById: null, via });
      console.log(
        `${args.slug} r${draft.revision}: validation started — ${started.runIds.length} model solution run(s)` +
          (started.cancelled ? `, ${started.cancelled} earlier run(s) cancelled` : ""),
      );
      for (const note of started.notes) console.log(`  note: ${note}`);
    } catch (error) {
      if (error instanceof validation.ValidationSetupError) fail(`${args.slug}: ${error.message}`);
      throw error;
    }
  } else if (running) {
    console.log(`${args.slug} r${draft.revision}: validation already in progress (${status.phase}); waiting.`);
  }

  const waited = await wait.waitForValidation(versionId, {
    timeoutMs: args.timeoutMs,
    onPhase: (s) => console.log(`  ${new Date().toISOString()}  ${s.phase}${s.pending ? ` (${s.pending} pending)` : ""}`),
  });
  status = waited.status;
  if (waited.timedOut) {
    fail(
      `${args.slug}: timed out waiting for the judges (is a judge node up and serving the REJUDGE lane?). ` +
        "Validation continues in the background; run this script again to resume.",
      2,
    );
  }

  const runs = await db.validationRun.findMany({
    where: { problemVersionId: versionId, judgeSeq: status.judgeSeq },
    orderBy: { createdAt: "desc" },
    distinct: ["referenceSolutionId"],
    select: {
      language: true,
      verdict: true,
      outcome: true,
      measuredMs: true,
      referenceSolution: { select: { label: true, expectedVerdict: true } },
    },
  });
  console.log("Reference solutions:");
  for (const r of runs) {
    console.log(
      `  ${r.outcome.padEnd(10)} ${r.language.padEnd(8)} expected ${r.referenceSolution.expectedVerdict.padEnd(4)} ` +
        `got ${(r.verdict ?? "—").padEnd(7)} ${r.measuredMs ?? "—"} ms  ${r.referenceSolution.label ?? ""}`,
    );
  }
  for (const note of status.notes) console.log(`  note: ${note}`);

  if (!status.publishable) {
    console.error(`${args.slug} r${draft.revision}: publishing is blocked:`);
    for (const blocker of status.blockers) console.error(`  - ${blocker}`);
    process.exit(1);
  }

  if (args.approve) {
    const actor = { actorId: null, via };
    const state = await db.problemVersion.findUniqueOrThrow({
      where: { id: versionId },
      select: { status: true, approvedAt: true, editSeq: true },
    });
    try {
      if (state.status === "DRAFT") {
        await review.submitVersionForReview(
          {
            versionId,
            expectedEditSeq: state.editSeq,
            attestedOriginal: true,
            comment: `Submitted by the operator CLI (${via}); the content is originally authored.`,
          },
          actor,
        );
        console.log(`${args.slug} r${draft.revision}: submitted for review (operator).`);
      }
      if (!state.approvedAt) {
        await review.approveVersion({ versionId, comment: `Operator approval (${via}).` }, actor);
        console.log(`${args.slug} r${draft.revision}: approved (operator).`);
      }
    } catch (error) {
      if (error instanceof errors.AppError) fail(`${args.slug}: ${error.message}`);
      throw error;
    }
  }

  const published = await validation.publishVersion(versionId, { actorId: null, via });
  if (!published.ok) {
    if (published.reason === "BLOCKED") {
      console.error(`${args.slug}: publishing is blocked:`);
      for (const blocker of published.blockers) console.error(`  - ${blocker}`);
      if (published.blockers.includes(validation.NOT_APPROVED_BLOCKER)) {
        console.error("  (pass --approve for an operator approval, or have a second admin approve it in /admin/problems)");
      }
    } else {
      console.error(`${args.slug}: ${published.message}`);
    }
    process.exit(1);
  }
  const limits = await db.problemLanguageLimit.findMany({
    where: { problemVersionId: versionId },
    orderBy: { language: "asc" },
    select: { language: true, timeLimitMs: true, memoryLimitKb: true, measuredModelMs: true },
  });
  console.log(`${args.slug}: published revision ${published.revision}. Per-language limits:`);
  for (const l of limits) {
    const basis = l.measuredModelMs === null ? "fallback multiplier" : `model ${l.measuredModelMs} ms`;
    console.log(`  ${l.language.padEnd(8)} ${String(l.timeLimitMs).padStart(5)} ms  ${l.memoryLimitKb} KB  (${basis})`);
  }
  // The publish has committed; a plan refresh that fails is reported, not fatal.
  try {
    const { syncSeededStudyPlans } = await import("./content/study-plans");
    for (const r of await syncSeededStudyPlans(db)) {
      console.log(`study plan ${r.slug}: ${r.itemsTotal} items (+${r.added} −${r.removed}, ${r.moved} moved)`);
    }
  } catch (error) {
    console.error("Refreshing the seeded study plans failed (re-run scripts/seed.ts to retry):", error);
  }
  await db.$disconnect();
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error("validate-and-publish failed:", error);
  process.exit(1);
});
