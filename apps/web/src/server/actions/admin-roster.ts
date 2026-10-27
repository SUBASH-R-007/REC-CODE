"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { Prisma } from "@recx/db";
import { ROSTER_IMPORT_LIMITS, rosterRowSchema } from "@recx/shared";
import { audit } from "@/lib/audit";
import { describeScope, requireAdminScopeAction } from "@/lib/auth/scope";
import { db } from "@/lib/db";
import { ConflictError, NotFoundError, RateLimitError, ValidationError, runAction, type ActionResult } from "@/lib/errors";
import { requestIpHash } from "@/lib/ip";
import { hitRateLimit } from "@/lib/rate-limit";
import { parseRosterCsv, validateRosterLines } from "@/lib/admin/roster-csv";
import { applyRosterPlan, loadRosterMatches, parseStoredLines } from "@/lib/admin/roster";
import { planRosterImport, rosterPlanSha256 } from "@/lib/admin/roster-plan";

/**
 * The roster: an LMS export previewed and committed separately, and one
 * student typed in by hand.
 *
 *   previewRosterImport  ADMIN  dry run: writes only a RosterImport (60-minute preview)
 *   commitRosterImport   ADMIN  re-plans; refuses unless the plan's hash equals what was shown
 *   discardRosterImport  ADMIN  closes a preview and drops its rows
 *   addStudent           ADMIN  one row, same validation and same write path
 *
 * The import never changes a role, an account status or a password, and
 * accounts it creates have no password (docs/OPEN-QUESTIONS.md). The
 * previewed rows (PII) are dropped on commit, discard or expiry.
 */

const PREVIEW_MINUTES = 60;
const BULK_RATE = { limit: 10, windowMs: 60_000 } as const;

async function bulkRateLimit(userId: string) {
  const hit = await hitRateLimit(`admin-bulk:${userId}`, BULK_RATE);
  if (!hit.allowed) throw new RateLimitError();
}

/** Close previews whose hour has passed (their rows are dropped). */
async function expireStalePreviews(now: Date) {
  await db.rosterImport.updateMany({
    where: { status: "PREVIEWED", expiresAt: { lte: now } },
    data: { status: "EXPIRED", rows: Prisma.DbNull },
  });
}

function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "roster.csv";
  // eslint-disable-next-line no-control-regex
  return base.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200) || "roster.csv";
}

/** `<form action>` entry point (useActionState): field `file`, a .csv of at most 900 KB. Redirects to the preview. */
export async function previewRosterImport(
  _previous: ActionResult<{ importId: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ importId: string }>> {
  return runAction(async () => {
    const { user, scope } = await requireAdminScopeAction();
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) throw new ValidationError("Choose a CSV file to import.");
    if (!/\.csv$/i.test(file.name)) throw new ValidationError("The roster must be a .csv file.");
    if (file.size > ROSTER_IMPORT_LIMITS.maxBytes) {
      throw new ValidationError(`The file is larger than ${Math.round(ROSTER_IMPORT_LIMITS.maxBytes / 1024)} KB.`);
    }
    await bulkRateLimit(user.id);

    const bytes = Buffer.from(await file.arrayBuffer());
    const fileSha256 = createHash("sha256").update(bytes).digest("hex");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ValidationError("The file is not UTF-8 text. Export the roster as CSV (UTF-8).");
    }
    const parsed = parseRosterCsv(text);
    if (parsed.errors.length > 0) {
      const first = parsed.errors[0]!;
      const more = parsed.errors.length > 1 ? ` (and ${parsed.errors.length - 1} more problem${parsed.errors.length > 2 ? "s" : ""})` : "";
      throw new ValidationError(`${first.line > 0 ? `Line ${first.line}: ` : ""}${first.message}${more}`);
    }
    if (parsed.rows.length === 0) throw new ValidationError("The file has a header but no rows.");

    const lines = validateRosterLines(parsed.rows);
    const matches = await loadRosterMatches(
      db,
      scope,
      lines.flatMap((l) => (l.row ? [l.row] : [])),
    );
    const plan = planRosterImport(lines, matches, scope);
    const now = new Date();
    await expireStalePreviews(now);
    const created = await db.rosterImport.create({
      data: {
        status: "PREVIEWED",
        createdById: user.id,
        fileName: cleanFileName(file.name),
        fileSha256,
        rowCount: lines.length,
        rows: lines as unknown as Prisma.InputJsonValue,
        counts: { ...plan.counts },
        diffSha256: rosterPlanSha256(plan),
        expiresAt: new Date(now.getTime() + PREVIEW_MINUTES * 60_000),
      },
      select: { id: true },
    });
    await audit({
      actorId: user.id,
      action: "roster.import.previewed",
      entityType: "RosterImport",
      entityId: created.id,
      sensitivity: "NORMAL",
      metadata: { importId: created.id, fileSha256, rowCount: lines.length, counts: { ...plan.counts } },
      ipHash: await requestIpHash(),
    });
    redirect(`/admin/students/import/${created.id}`);
  }, "previewRosterImport");
}

const importIdSchema = z.string().trim().min(1).max(64);

const commitSchema = z.object({
  importId: importIdSchema,
  diffSha256: z.string().regex(/^[0-9a-f]{64}$/, "This preview is out of date. Reload the page."),
});
export type CommitRosterImportInput = z.input<typeof commitSchema>;

/**
 * Apply a previewed import. One transaction under a global advisory lock:
 * the plan is recomputed from the stored rows against the accounts as they
 * are now, and the commit is refused unless its hash equals the one the
 * importer was shown.
 */
export async function commitRosterImport(input: CommitRosterImportInput): Promise<ActionResult<{ importId: string }>> {
  return runAction(async () => {
    const { user, scope } = await requireAdminScopeAction();
    const parsed = commitSchema.parse(input);
    await bulkRateLimit(user.id);
    const now = new Date();

    const outcome = await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('roster-import'))`;
        const row = await tx.rosterImport.findUnique({
          where: { id: parsed.importId },
          select: { id: true, status: true, createdById: true, expiresAt: true, rows: true },
        });
        if (!row || (row.createdById !== user.id && user.role !== "SUPER_ADMIN")) {
          throw new NotFoundError("That import was not found.");
        }
        if (row.status !== "PREVIEWED") throw new ConflictError("This import was already committed or discarded.");
        if (row.expiresAt <= now) throw new ConflictError("This preview has expired. Upload the file again.");
        const lines = parseStoredLines(row.rows);
        if (!lines) throw new ConflictError("This preview can no longer be read. Upload the file again.");

        const matches = await loadRosterMatches(
          tx,
          scope,
          lines.flatMap((l) => (l.row ? [l.row] : [])),
        );
        const plan = planRosterImport(lines, matches, scope);
        if (rosterPlanSha256(plan) !== parsed.diffSha256) {
          throw new ConflictError("The data changed since your preview — review the new diff and commit again.");
        }
        const applied = await applyRosterPlan(tx, plan, scope, now);
        const resultsJson = JSON.stringify(applied.results);
        const resultsSha256 = createHash("sha256").update(resultsJson).digest("hex");
        const closed = await tx.rosterImport.updateMany({
          where: { id: row.id, status: "PREVIEWED" },
          data: {
            status: "COMMITTED",
            rows: Prisma.DbNull,
            results: applied.results as unknown as Prisma.InputJsonValue,
            resultsSha256,
            committedAt: now,
            counts: { ...plan.counts },
          },
        });
        if (closed.count !== 1) throw new ConflictError("This import was already committed or discarded.");
        return { counts: plan.counts, resultsSha256, moves: applied.moves };
      },
      { timeout: 60_000, maxWait: 10_000 },
    );

    const ipHash = await requestIpHash();
    await audit({
      actorId: user.id,
      action: "roster.import.committed",
      entityType: "RosterImport",
      entityId: parsed.importId,
      sensitivity: "SENSITIVE",
      metadata: {
        importId: parsed.importId,
        counts: { ...outcome.counts },
        resultsSha256: outcome.resultsSha256,
        scope: describeScope(scope),
      },
      ipHash,
    });
    for (const move of outcome.moves) {
      await audit({
        actorId: user.id,
        action: "student.cohort.changed",
        entityType: "User",
        entityId: move.userId,
        targetUserId: move.userId,
        sensitivity: "NORMAL",
        metadata: { from: move.from, to: move.to, importId: parsed.importId },
        ipHash,
      });
    }
    revalidatePath("/admin/students");
    revalidatePath(`/admin/students/import/${parsed.importId}`);
    return { importId: parsed.importId };
  }, "commitRosterImport");
}

const discardSchema = z.object({ importId: importIdSchema });
export type DiscardRosterImportInput = z.input<typeof discardSchema>;

export async function discardRosterImport(input: DiscardRosterImportInput): Promise<ActionResult<{ importId: string }>> {
  return runAction(async () => {
    const { user } = await requireAdminScopeAction();
    const { importId } = discardSchema.parse(input);
    const row = await db.rosterImport.findUnique({ where: { id: importId }, select: { id: true, createdById: true } });
    if (!row || (row.createdById !== user.id && user.role !== "SUPER_ADMIN")) {
      throw new NotFoundError("That import was not found.");
    }
    const closed = await db.rosterImport.updateMany({
      where: { id: importId, status: "PREVIEWED" },
      data: { status: "EXPIRED", rows: Prisma.DbNull },
    });
    if (closed.count !== 1) throw new ConflictError("This import was already committed or discarded.");
    await audit({
      actorId: user.id,
      action: "roster.import.discarded",
      entityType: "RosterImport",
      entityId: importId,
      sensitivity: "NORMAL",
      metadata: { importId },
      ipHash: await requestIpHash(),
    });
    revalidatePath(`/admin/students/import/${importId}`);
    return { importId };
  }, "discardRosterImport");
}

/**
 * One student, typed in rather than imported: `/admin/students/new`.
 *
 * It exists because a roster export is the wrong instrument for a late
 * admission or a transfer — an ADMIN had either to edit a CSV and import a
 * file of one row, or to wait for the next roster sync — and because
 * "add a student" was the obvious hole in the admin surface.
 *
 * What makes it safe is that it is not a second way to create a student.
 * The field validation is `rosterRowSchema`, the conflict and scope
 * decisions are `planRosterImport`, and the write is `applyRosterPlan` —
 * the same three as a file. The only thing it does differently is refuse
 * anything that is not a clean CREATE: a row that would update, link,
 * skip, or that collides with an account the importer cannot see, comes
 * back as the plan's own message instead of quietly changing somebody.
 *
 * No RosterImport row is written. A manual add has no file name and no file
 * hash, and inventing them would put a lie in a provenance field; the audit
 * entry (`student.added`, with the actor and the scope) is the provenance.
 */
const ADD_STUDENT_FIELDS = ["lmsUserId", "collegeId", "email", "firstName", "lastName", "batchYear", "departmentCode", "section"] as const;

/**
 * A `<form action>` entry point, like the upload above: it takes FormData,
 * so the page works before hydration — the one moment an admin is most
 * likely to be on a bad connection is the start of term, which is also
 * when this page is used.
 */
export async function addStudent(
  _previous: ActionResult<{ userId: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ userId: string }>> {
  return runAction(async () => {
    const { user, scope } = await requireAdminScopeAction();
    const entries = Object.fromEntries(
      ADD_STUDENT_FIELDS.map((field) => {
        const value = formData.get(field);
        return [field, typeof value === "string" ? value : ""];
      }),
    );
    const row = rosterRowSchema.parse(entries);
    await bulkRateLimit(user.id);
    const now = new Date();

    const userId = await db.$transaction(async (tx) => {
      // The same advisory lock an import takes, so a manual add and a file
      // cannot interleave and both decide a roll number is free.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('roster-import'))`;
      const matches = await loadRosterMatches(tx, scope, [row]);
      const plan = planRosterImport([{ line: 1, row, error: null }], matches, scope);
      const outcome = plan.lines[0]!.outcome;

      if (outcome.kind === "REJECTED") throw new ValidationError(outcome.message);
      if (outcome.kind !== "CREATE") {
        /**
         * UPDATE, UNCHANGED and SKIPPED all mean the same thing here: this
         * roll number, email or LMS id already belongs to an account. An
         * ADMIN may see their own students, so naming the collision is not
         * a disclosure — and a collision OUTSIDE their scope never reaches
         * this branch, because the plan rejects it with no detail.
         */
        throw new ConflictError(
          "An account already exists for that roll number, email or LMS id. Open it from the student list instead.",
        );
      }

      const applied = await applyRosterPlan(tx, plan, scope, now);
      const created = applied.results.find((r) => r.outcome === "CREATE")?.userId;
      if (!created) throw new ConflictError("The student was not created — try again.");
      return created;
    });

    await audit({
      actorId: user.id,
      action: "student.added",
      entityType: "User",
      entityId: userId,
      targetUserId: userId,
      sensitivity: "SENSITIVE",
      metadata: { collegeId: row.collegeId, scope: describeScope(scope), source: "manual" },
      ipHash: await requestIpHash(),
    });
    revalidatePath("/admin/students");
    // Straight to the student that now exists, which is where the admin was
    // going: the list would make them search for the person they just typed.
    redirect(`/admin/students/${userId}`);
  }, "addStudent");
}
