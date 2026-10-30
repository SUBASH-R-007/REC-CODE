import "server-only";
import { Prisma, type ContentOrigin, type Topic } from "@recx/db";
import {
  SQL_DIALECT,
  functionCompareMode,
  functionSignatureSchema,
  type CompareMode,
  type IoMode,
} from "@recx/shared";
import type { Difficulty } from "@recx/shared/authoring";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { cloneVersionAsDraft } from "@/lib/judge/validation";
import { lockSlug } from "./draft";
import { retryingTransaction } from "./retry";

/**
 * Creating a problem and starting a new revision of one. Retiring and
 * deleting are SUPER_ADMIN operations owned by the governance stream
 * (src/server/actions/super-problems.ts); they are not here.
 */

export interface AuthoringActor {
  actorId: string | null;
  via: string;
  ipHash?: string | null;
}

export interface CreateProblemData {
  slug: string;
  displayCode: string;
  title: string;
  difficulty: Difficulty;
  ioMode: IoMode;
  compareMode: CompareMode;
  functionSignature: Record<string, unknown> | null;
  statementMd: string;
  timeLimitMs: number;
  memoryLimitKb: number;
  origin: ContentOrigin;
  topics: readonly Topic[];
  constraints?: readonly string[];
}

/**
 * The compare mode a FUNCTION draft carries: the one its declared comparator
 * implies (CHECKER for CUSTOM_CHECKER, otherwise TOKEN). STDIN keeps the
 * author's choice.
 */
export function effectiveCompareMode(ioMode: IoMode, compareMode: CompareMode, signature: unknown): CompareMode {
  if (ioMode !== "FUNCTION") return compareMode;
  const sig = functionSignatureSchema.safeParse(signature);
  return sig.success ? functionCompareMode(sig.data.comparator) : compareMode;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/** A new problem (status DRAFT) with its revision 1 (DRAFT) and its topic tags. */
export async function createProblemWithDraft(
  data: CreateProblemData,
  actor: AuthoringActor,
): Promise<{ problemId: string; versionId: string }> {
  const signature = data.ioMode === "FUNCTION" ? data.functionSignature : null;
  let created: { problemId: string; versionId: string };
  try {
    created = await retryingTransaction(
      async (tx) => {
        await lockSlug(tx, data.slug);
        const clash = await tx.problem.findFirst({
          where: { OR: [{ slug: data.slug }, { displayCode: data.displayCode }] },
          select: { slug: true, displayCode: true },
        });
        if (clash?.slug === data.slug) throw new ConflictError(`The slug ${data.slug} is already taken.`);
        if (clash) throw new ConflictError(`The display code ${data.displayCode} is already taken.`);
        const problem = await tx.problem.create({
          data: {
            slug: data.slug,
            displayCode: data.displayCode,
            title: data.title,
            difficulty: data.difficulty,
            status: "DRAFT",
            createdById: actor.actorId,
          },
          select: { id: true },
        });
        const version = await tx.problemVersion.create({
          data: {
            problemId: problem.id,
            revision: 1,
            status: "DRAFT",
            title: data.title,
            difficulty: data.difficulty,
            statementMd: data.statementMd,
            constraints: [...(data.constraints ?? [])],
            ioMode: data.ioMode,
            ...(signature ? { functionSignature: signature as Prisma.InputJsonValue } : {}),
            /**
             * Phase 12k. A SQL problem compares result sets, is judged in
             * the one dialect, and starts ordered — the author's three
             * facts, decided here rather than asked for on a form whose
             * other fields describe programs. The database's CHECKs say the
             * same thing from the other side.
             */
            ...(data.ioMode === "SQL"
              ? { compareMode: "ROWS" as const, sqlDialect: SQL_DIALECT, sqlOrdered: true }
              : { compareMode: effectiveCompareMode(data.ioMode, data.compareMode, signature) }),
            timeLimitMs: data.timeLimitMs,
            memoryLimitKb: data.memoryLimitKb,
            origin: data.origin,
            createdById: actor.actorId,
            lastEditedById: actor.actorId,
          },
          select: { id: true },
        });
        if (data.topics.length > 0) {
          await tx.problemTag.createMany({ data: [...new Set(data.topics)].map((topic) => ({ problemId: problem.id, topic })) });
        }
        return { problemId: problem.id, versionId: version.id };
      },
      { timeout: 30_000 },
    );
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError("That slug or display code is already taken.");
    throw error;
  }
  await audit({
    actorId: actor.actorId,
    action: "problem.created",
    entityType: "Problem",
    entityId: created.problemId,
    sensitivity: "NORMAL",
    metadata: { slug: data.slug, displayCode: data.displayCode, versionId: created.versionId, origin: data.origin, via: actor.via },
    ipHash: actor.ipHash ?? null,
  });
  return created;
}

/**
 * "Edit problem": the problem's open draft if it has one, otherwise a new
 * DRAFT revision cloned from the live one (one open draft per problem,
 * enforced under the problem lock). A retired problem gets no new revision.
 */
export async function startRevision(
  problemId: string,
  actor: AuthoringActor,
): Promise<{ versionId: string; revision: number; existing: boolean }> {
  const openDraft = () =>
    db.problemVersion.findFirst({
      where: { problemId, frozenAt: null },
      orderBy: { revision: "desc" },
      select: { id: true, revision: true },
    });
  const problem = await db.problem.findUnique({ where: { id: problemId }, select: { status: true, liveVersionId: true } });
  if (!problem) throw new NotFoundError("That problem was not found.");
  if (problem.status === "RETIRED") throw new ConflictError("This problem is retired; it gets no new revisions.");
  const existing = await openDraft();
  if (existing) return { versionId: existing.id, revision: existing.revision, existing: true };
  if (!problem.liveVersionId) throw new ConflictError("This problem has no published revision to start from.");
  try {
    const created = await cloneVersionAsDraft(problem.liveVersionId, {
      createdById: actor.actorId,
      via: actor.via,
      refuseIfDraftExists: true,
      ipHash: actor.ipHash ?? null,
    });
    return { versionId: created.versionId, revision: created.revision, existing: false };
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    // Someone else opened the draft a moment ago: hand back theirs.
    const raced = await openDraft();
    if (!raced) throw error;
    return { versionId: raced.id, revision: raced.revision, existing: true };
  }
}

/** Topic tags belong to the Problem (no new revision needed). */
export async function setProblemTopics(problemId: string, topics: readonly Topic[], actor: AuthoringActor): Promise<{ topics: Topic[] }> {
  const wanted = [...new Set(topics)];
  const before = await retryingTransaction(async (tx) => {
    const problem = await tx.problem.findUnique({ where: { id: problemId }, select: { id: true, tags: { select: { topic: true } } } });
    if (!problem) throw new NotFoundError("That problem was not found.");
    await tx.problemTag.deleteMany({ where: { problemId, topic: { notIn: wanted } } });
    await tx.problemTag.createMany({ data: wanted.map((topic) => ({ problemId, topic })), skipDuplicates: true });
    return problem.tags.map((t) => t.topic);
  });
  await audit({
    actorId: actor.actorId,
    action: "problem.topics.changed",
    entityType: "Problem",
    entityId: problemId,
    sensitivity: "NORMAL",
    metadata: { from: before, to: wanted, via: actor.via },
    ipHash: actor.ipHash ?? null,
  });
  return { topics: wanted };
}
