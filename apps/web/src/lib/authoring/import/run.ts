import "server-only";
import { Prisma, type DbTx, type ProblemImportRowStatus } from "@recx/db";
import { TESTLIB_ID } from "@recx/shared";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { referenceId } from "@/lib/errors";
import { ensureTestBlob } from "@/lib/testdata/blobs";
import { getTestDataStore } from "@/lib/testdata/store";
import { lockProblem, lockSlug } from "../draft";
import { withTransientRetry } from "../retry";
import { effectiveCompareMode } from "../lifecycle";
import { ArchiveEntryError, type ProblemArchive } from "./archive";
import { parseProblemPackage, type PackageFiles, type PackageIssue, type ProblemPackage } from "./package";

/**
 * Bulk import: one transaction per problem directory, one ProblemImportRow
 * written as soon as that directory commits or fails — so one bad entry
 * cannot discard a 300-problem batch. Re-importing the same archive is
 * always safe: a directory whose canonical package hash matches the open
 * draft or the live revision comes back UNCHANGED.
 *
 *   slug unknown                         CREATED       problem + r1 DRAFT + topic tags
 *   open draft, same package             UNCHANGED
 *   open draft, other content            FAILED        finish or delete that draft first
 *   no draft, live revision same package UNCHANGED
 *   no draft, live content differs       NEW_REVISION  r(max+1) DRAFT (topics untouched; a difference is a warning)
 *   RETIRED, or display code mismatched/taken           FAILED
 *
 * Blobs go in first, outside the transaction (content-addressed, so a retry
 * is idempotent). No bundle is written: bundles are written by publish only.
 * Validation is not started; "Validate imported drafts" does that.
 */

export interface ImportRowResult {
  entry: string;
  status: ProblemImportRowStatus;
  slug: string | null;
  problemId: string | null;
  versionId: string | null;
  revision: number | null;
  packageSha256: string | null;
  errors: PackageIssue[];
  warnings: PackageIssue[];
}

export interface ImportContext {
  importId: string;
  actorId: string;
}

/** A PROCESSING import older than this is presumed dead (the process restarted). */
export const IMPORT_STALE_AFTER_MS = 30 * 60 * 1000;

class RowFailure extends Error {
  constructor(readonly issues: PackageIssue[]) {
    super(issues[0]?.message ?? "failed");
  }
}

const json = (issues: readonly PackageIssue[]) => issues as unknown as Prisma.InputJsonValue;

async function writeRow(client: typeof db | DbTx, importId: string, row: ImportRowResult): Promise<void> {
  await client.problemImportRow.create({
    data: {
      importId,
      entry: row.entry.slice(0, 200),
      slug: row.slug,
      status: row.status,
      problemId: row.problemId,
      problemVersionId: row.versionId,
      revision: row.revision,
      packageSha256: row.packageSha256,
      errors: json(row.errors),
      warnings: json(row.warnings),
    },
  });
  const counter = { CREATED: "created", NEW_REVISION: "revised", UNCHANGED: "unchanged", FAILED: "failed" } as const;
  await client.problemImport.update({ where: { id: importId }, data: { [counter[row.status]]: { increment: 1 } } });
}

async function writeVersion(
  tx: DbTx,
  input: {
    problemId: string;
    revision: number;
    pkg: ProblemPackage;
    tests: { inputSha256: string; outputSha256: string }[];
    checkerSha256: string | null;
    interactorSha256: string | null;
    packageSha256: string;
    actorId: string;
  },
): Promise<string> {
  const { meta } = input.pkg;
  const signature = meta.ioMode === "FUNCTION" ? (meta.functionSignature as Prisma.InputJsonValue) : undefined;
  const version = await tx.problemVersion.create({
    data: {
      problemId: input.problemId,
      revision: input.revision,
      status: "DRAFT",
      title: meta.title,
      difficulty: meta.difficulty,
      statementMd: input.pkg.statement,
      constraints: meta.constraints,
      ioMode: meta.ioMode,
      ...(signature !== undefined ? { functionSignature: signature } : {}),
      compareMode: effectiveCompareMode(meta.ioMode, meta.compareMode, meta.functionSignature),
      floatEpsilon: meta.floatEpsilon,
      scoringMode: meta.scoringMode,
      stopOnFirstFailure: meta.stopOnFirstFailure,
      timeLimitMs: meta.timeLimitMs,
      memoryLimitKb: meta.memoryLimitKb,
      checkerSha256: input.checkerSha256,
      interactorSha256: input.interactorSha256,
      testlibId: input.checkerSha256 || input.interactorSha256 ? TESTLIB_ID : null,
      origin: meta.origin,
      createdById: input.actorId,
      lastEditedById: input.actorId,
      importSha256: input.packageSha256,
    },
    select: { id: true },
  });
  const versionId = version.id;
  await tx.testCase.createMany({
    data: input.pkg.tests.map((t, i) => ({
      problemVersionId: versionId,
      index: t.index,
      isSample: t.isSample,
      subtaskIndex: t.subtaskIndex,
      points: t.points,
      inputSha256: input.tests[i]!.inputSha256,
      outputSha256: input.tests[i]!.outputSha256,
    })),
  });
  if (meta.subtasks.length > 0) {
    await tx.subtask.createMany({
      data: meta.subtasks.map((s) => ({
        problemVersionId: versionId,
        index: s.index,
        points: s.points,
        aggregation: s.aggregation,
        dependsOn: [...new Set(s.dependsOn)].sort((a, b) => a - b),
      })),
    });
  }
  if (input.pkg.solutions.length > 0) {
    await tx.referenceSolution.createMany({
      data: input.pkg.solutions.map((s) => ({
        problemVersionId: versionId,
        language: s.language,
        label: s.label,
        source: s.source,
        expectedVerdict: s.expected,
      })),
    });
  }
  if (input.pkg.starters.length > 0) {
    await tx.starterCode.createMany({
      data: input.pkg.starters.map((s) => ({ problemVersionId: versionId, language: s.language, code: s.code })),
    });
  }
  if (input.pkg.hints.length > 0) {
    await tx.hint.createMany({ data: input.pkg.hints.map((contentMd, i) => ({ problemVersionId: versionId, tier: i + 1, contentMd })) });
  }
  if (input.pkg.editorial !== null && input.pkg.editorial.trim().length > 0) {
    await tx.editorial.create({ data: { problemVersionId: versionId, contentMd: input.pkg.editorial } });
  }
  return versionId;
}

/** Import one problem directory and record its row. Never throws for content problems. */
export async function importOnePackage(entry: string, files: PackageFiles, ctx: ImportContext): Promise<ImportRowResult> {
  const parsed = parseProblemPackage(entry, files);
  if (!parsed.ok) {
    const row: ImportRowResult = {
      entry,
      status: "FAILED",
      slug: null,
      problemId: null,
      versionId: null,
      revision: null,
      packageSha256: null,
      errors: parsed.errors,
      warnings: parsed.warnings,
    };
    await writeRow(db, ctx.importId, row);
    return row;
  }
  const { pkg, packageSha256 } = parsed;
  const warnings = [...parsed.warnings];
  const meta = pkg.meta;

  // Blobs first: content-addressed, idempotent, outside the transaction.
  const store = getTestDataStore();
  const tests: { inputSha256: string; outputSha256: string }[] = [];
  for (const t of pkg.tests) {
    tests.push({
      inputSha256: (await ensureTestBlob(db, store, t.input)).sha256,
      outputSha256: (await ensureTestBlob(db, store, t.output)).sha256,
    });
  }
  const checkerSha256 = pkg.checker !== null ? (await ensureTestBlob(db, store, Buffer.from(pkg.checker, "utf8"))).sha256 : null;
  const interactorSha256 =
    pkg.interactor !== null ? (await ensureTestBlob(db, store, Buffer.from(pkg.interactor, "utf8"))).sha256 : null;

  const base = { entry, slug: meta.slug, packageSha256 };
  try {
    return await withTransientRetry(() => db.$transaction(
      async (tx) => {
        // A retried attempt starts from the parsed warnings again (no duplicate topic warning).
        warnings.length = parsed.warnings.length;
        await lockSlug(tx, meta.slug);
        const readProblem = () =>
          tx.problem.findUnique({
            where: { slug: meta.slug },
            select: {
              id: true,
              status: true,
              displayCode: true,
              liveVersionId: true,
              tags: { select: { topic: true } },
              liveVersion: { select: { importSha256: true, revision: true } },
              versions: { orderBy: { revision: "desc" }, select: { id: true, revision: true, frozenAt: true, importSha256: true } },
            },
          });
        const found = await readProblem();
        let row: ImportRowResult;
        if (!found) {
          const taken = await tx.problem.findUnique({ where: { displayCode: meta.displayCode }, select: { slug: true } });
          if (taken) throw new RowFailure([{ path: "meta.json", message: `The display code ${meta.displayCode} is already used by ${taken.slug}.` }]);
          const created = await tx.problem.create({
            data: {
              slug: meta.slug,
              displayCode: meta.displayCode,
              title: meta.title,
              difficulty: meta.difficulty,
              status: "DRAFT",
              createdById: ctx.actorId,
            },
            select: { id: true },
          });
          await tx.problemTag.createMany({ data: [...new Set(meta.topics)].map((topic) => ({ problemId: created.id, topic })) });
          const versionId = await writeVersion(tx, {
            problemId: created.id,
            revision: 1,
            pkg,
            tests,
            checkerSha256,
            interactorSha256,
            packageSha256,
            actorId: ctx.actorId,
          });
          row = { ...base, status: "CREATED", problemId: created.id, versionId, revision: 1, errors: [], warnings };
        } else {
          await lockProblem(tx, found.id);
          // Decide on the state AFTER the problem lock: a revision another
          // admin started (or published) a moment ago is seen, not overwritten.
          const problem = (await readProblem()) ?? found;
          if (problem.status === "RETIRED") throw new RowFailure([{ path: "meta.json", message: `${meta.slug} is retired; it takes no new revisions.` }]);
          if (problem.displayCode !== meta.displayCode) {
            throw new RowFailure([
              { path: "meta.json", message: `${meta.slug} has display code ${problem.displayCode}; the package says ${meta.displayCode}.` },
            ]);
          }
          const draft = problem.versions.find((v) => v.frozenAt === null) ?? null;
          const common = { ...base, problemId: problem.id, errors: [] as PackageIssue[] };
          if (draft) {
            if (draft.importSha256 !== packageSha256) {
              throw new RowFailure([
                { path: "", message: `Revision ${draft.revision} of ${meta.slug} is an open draft; finish or delete it first.` },
              ]);
            }
            row = { ...common, status: "UNCHANGED", versionId: draft.id, revision: draft.revision, warnings };
          } else if (problem.liveVersion && problem.liveVersion.importSha256 === packageSha256) {
            row = { ...common, status: "UNCHANGED", versionId: problem.liveVersionId, revision: problem.liveVersion.revision, warnings };
          } else {
            const current = new Set(problem.tags.map((t) => t.topic));
            const wanted = new Set(meta.topics);
            if (current.size !== wanted.size || [...wanted].some((t) => !current.has(t))) {
              warnings.push({ path: "meta.json", message: "The topics differ from the problem's; topics are changed on the problem page, not by import." });
            }
            const revision = (problem.versions[0]?.revision ?? 0) + 1;
            const versionId = await writeVersion(tx, {
              problemId: problem.id,
              revision,
              pkg,
              tests,
              checkerSha256,
              interactorSha256,
              packageSha256,
              actorId: ctx.actorId,
            });
            row = { ...common, status: "NEW_REVISION", versionId, revision, warnings };
          }
        }
        await writeRow(tx, ctx.importId, row);
        return row;
      },
      { timeout: 120_000, maxWait: 30_000 },
    ));
  } catch (error) {
    let issues: PackageIssue[];
    if (error instanceof RowFailure) issues = error.issues;
    else if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      issues = [{ path: "meta.json", message: "The slug or display code was taken by another import at the same moment; re-import." }];
    } else {
      const ref = referenceId();
      console.error(`[import] ${ctx.importId} entry ${entry} failed (ref ${ref}):`, error);
      issues = [{ path: "", message: `Unexpected error; quote reference ${ref}.` }];
    }
    const row: ImportRowResult = { ...base, status: "FAILED", problemId: null, versionId: null, revision: null, errors: issues, warnings };
    await writeRow(db, ctx.importId, row);
    return row;
  }
}

/**
 * Import every problem directory of an archive in order, then mark the
 * import DONE. Each directory fails on its own; the archive is closed in
 * every case. Returns the per-row results.
 */
export async function runProblemImport(importId: string, archive: ProblemArchive, actorId: string): Promise<ImportRowResult[]> {
  const results: ImportRowResult[] = [];
  try {
    await db.problemImport.update({ where: { id: importId }, data: { total: archive.entries.length } });
    for (const entry of archive.entries) {
      let files: PackageFiles;
      try {
        files = await archive.read(entry);
      } catch (error) {
        const issues =
          error instanceof ArchiveEntryError ? error.issues : [{ path: "", message: error instanceof Error ? error.message : "Unreadable." }];
        const row: ImportRowResult = {
          entry,
          status: "FAILED",
          slug: null,
          problemId: null,
          versionId: null,
          revision: null,
          packageSha256: null,
          errors: issues,
          warnings: [],
        };
        await writeRow(db, importId, row);
        results.push(row);
        continue;
      }
      results.push(await importOnePackage(entry, files, { importId, actorId }));
    }
    await db.problemImport.update({ where: { id: importId }, data: { status: "DONE", finishedAt: new Date() } });
    return results;
  } finally {
    await archive.close();
  }
}

/** Mark an import FAILED as a whole (not a zip, over a cap, interrupted). */
export async function failImport(importId: string, message: string): Promise<void> {
  await db.problemImport.updateMany({
    where: { id: importId, status: "PROCESSING" },
    data: { status: "FAILED", error: message.slice(0, 1000), finishedAt: new Date() },
  });
}

/** PROCESSING imports older than IMPORT_STALE_AFTER_MS were interrupted (a restart): mark them FAILED. */
export async function sweepStaleImports(now = new Date()): Promise<number> {
  const swept = await db.problemImport.updateMany({
    where: { status: "PROCESSING", startedAt: { lt: new Date(now.getTime() - IMPORT_STALE_AFTER_MS) } },
    data: { status: "FAILED", error: "Interrupted before it finished. Re-upload the archive: entries already imported come back UNCHANGED.", finishedAt: now },
  });
  return swept.count;
}

/** The audit row for a finished import: counters and up to 500 version ids. */
export async function auditImportCompleted(
  importId: string,
  actor: { actorId: string; via: string; ipHash?: string | null },
  results: readonly ImportRowResult[],
): Promise<void> {
  const counts = { CREATED: 0, NEW_REVISION: 0, UNCHANGED: 0, FAILED: 0 };
  for (const r of results) counts[r.status]++;
  await audit({
    actorId: actor.actorId,
    action: "problem.import.completed",
    entityType: "ProblemImport",
    entityId: importId,
    sensitivity: "NORMAL",
    metadata: {
      created: counts.CREATED,
      revised: counts.NEW_REVISION,
      unchanged: counts.UNCHANGED,
      failed: counts.FAILED,
      versionIds: results
        .filter((r) => r.versionId !== null && (r.status === "CREATED" || r.status === "NEW_REVISION"))
        .slice(0, 500)
        .map((r) => r.versionId as string),
      via: actor.via,
    },
    ipHash: actor.ipHash ?? null,
  });
}
