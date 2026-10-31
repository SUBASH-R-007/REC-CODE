import { Prisma } from "@prisma/client";

/**
 * Why the guard refused the write (FrozenVersionError.code):
 *   - "frozen": the write reached a published (frozen) revision or one of its
 *     children. A user can cause this (e.g. editing while someone publishes),
 *     so apps/web shows a conflict message for it.
 *   - "born_frozen": code tried to create a revision that is already frozen.
 *     Publishing is the only way to freeze, so this is always a bug in the
 *     calling code; apps/web logs it with a reference id.
 */
export type FrozenVersionErrorCode = "frozen" | "born_frozen";

export const FROZEN_VERSION_MESSAGE = "This problem version is published and frozen. Edit the problem to create a new revision.";
export const BORN_FROZEN_MESSAGE = "A revision is frozen by publishing it, never created frozen.";

/**
 * Repository-layer fence for structural decision (a): a published
 * ProblemVersion and its children (FROZEN_CHILD_MODELS) are immutable. The
 * database has a second fence (triggers ProblemVersion_frozen_guard,
 * ProblemVersion_born_frozen_guard and <Child>_frozen_guard, see the
 * migrations) so even raw SQL is refused.
 *
 * The one permitted write to a version is the publish transition itself:
 * setting frozenAt on a version whose frozenAt is still null. A version is
 * never created frozen.
 *
 * Nested writes through another model (e.g. `problem.update({ data: {
 * versions: { update } } })`) are invisible to this extension, which sees
 * only the top-level model; the database triggers catch those.
 */
export class FrozenVersionError extends Error {
  readonly code: FrozenVersionErrorCode;

  constructor(code: FrozenVersionErrorCode = "frozen", message?: string) {
    super(message ?? (code === "born_frozen" ? BORN_FROZEN_MESSAGE : FROZEN_VERSION_MESSAGE));
    this.name = "FrozenVersionError";
    this.code = code;
  }
}

/**
 * Version content: every model whose rows belong to one ProblemVersion and
 * freeze with it. Each has a `<Model>_frozen_guard` trigger in a migration
 * (packages/db/test/frozen-coverage.test.ts holds the two lists and the
 * triggers together).
 */
export const FROZEN_CHILD_MODELS: ReadonlySet<string> = new Set([
  "TestCase",
  "StarterCode",
  "ReferenceSolution",
  "Subtask",
  "ProblemLanguageLimit",
  "Hint",
  "Editorial",
]);

/** Models that reference ProblemVersion but stay writable after freeze, with the reason. */
export const FROZEN_EXEMPT_MODELS: Readonly<Record<string, string>> = Object.freeze({
  Problem: "holds liveVersionId; publish flips it",
  Submission: "pins a version; judged after freeze",
  RunRequest: "pins a version; judged after freeze",
  ValidationRun: "validation history of a version",
  ProblemReview:
    "review history of a draft revision, not version content; cascade-deleted with a deleted draft, append-only by convention",
  ContestProblem:
    "pins a frozen version into a contest; not version content. The ContestProblem_frozen_version trigger refuses an unfrozen version at INSERT and freezes contestId/problemVersionId/index afterwards",
  AssessmentProblem:
    "pins a frozen version into an assessment; not version content. The AssessmentProblem_frozen_version trigger refuses an unfrozen version at INSERT and freezes assessmentId/problemVersionId/position afterwards",
});

const WRITE_OPS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
]);
const CREATE_OPS = new Set(["create", "createMany", "createManyAndReturn"]);

type Lookup = {
  problemVersion: {
    findMany(args: unknown): Promise<{ id: string; frozenAt: Date | null }[]>;
    findUnique(args: unknown): Promise<{ id: string; frozenAt: Date | null } | null>;
  };
} & Record<
  string,
  {
    findMany(args: unknown): Promise<Array<{ problemVersionId: string }>>;
    findUnique(args: unknown): Promise<{ problemVersionId: string } | null>;
  }
>;

/** update / delete / upsert address one row by a WhereUniqueInput (possibly a
 * compound key such as problemVersionId_language), which findMany rejects. */
const UNIQUE_OPS = new Set(["update", "delete", "upsert"]);

function rowsOf(data: unknown): Record<string, unknown>[] {
  const rows = Array.isArray(data) ? data : [data];
  return rows.filter((row): row is Record<string, unknown> => !!row && typeof row === "object");
}

/** The version ids a create or update payload points a child at
 * (`problemVersionId`, `problemVersionId: { set }` or `problemVersion: { connect }`). */
function versionIdsFromWriteData(data: unknown): string[] {
  const ids: string[] = [];
  for (const r of rowsOf(data)) {
    const direct = r.problemVersionId;
    if (typeof direct === "string") ids.push(direct);
    else if (direct && typeof direct === "object" && typeof (direct as { set?: unknown }).set === "string") {
      ids.push((direct as { set: string }).set);
    }
    const rel = r.problemVersion as { connect?: { id?: string } } | undefined;
    if (rel?.connect?.id) ids.push(rel.connect.id);
  }
  return ids;
}

/** A ProblemVersion create payload that would insert a frozen row. */
function createsFrozenVersion(data: unknown): boolean {
  return rowsOf(data).some((r) => r.frozenAt !== undefined && r.frozenAt !== null);
}

async function assertNoneFrozen(client: Lookup, versionIds: string[]) {
  if (versionIds.length === 0) return;
  const frozen = await client.problemVersion.findMany({
    where: { id: { in: [...new Set(versionIds)] }, frozenAt: { not: null } },
    select: { id: true, frozenAt: true },
  });
  if (frozen.length > 0) throw new FrozenVersionError();
}

function lowerFirst(s: string) {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** Prisma client extension enforcing frozen-version immutability. */
export function frozenVersionGuard(lookup: () => Lookup) {
  return Prisma.defineExtension({
    name: "recx-frozen-version-guard",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!WRITE_OPS.has(operation)) return query(args);
          const client = lookup();
          const a = args as {
            where?: unknown;
            data?: Record<string, unknown> | unknown[];
            create?: unknown;
            update?: unknown;
          };

          if (model === "ProblemVersion") {
            if (CREATE_OPS.has(operation)) {
              if (createsFrozenVersion(a.data)) throw new FrozenVersionError("born_frozen");
              return query(args);
            }
            const select = { id: true, frozenAt: true };
            const targets = UNIQUE_OPS.has(operation)
              ? [await client.problemVersion.findUnique({ where: a.where, select })].filter((t) => t !== null)
              : await client.problemVersion.findMany({ where: a.where ?? {}, select });
            const frozen = targets.filter((t) => t.frozenAt !== null);
            if (frozen.length > 0) throw new FrozenVersionError();
            // An upsert that finds no row inserts its `create` branch.
            if (operation === "upsert" && targets.length === 0 && createsFrozenVersion(a.create)) {
              throw new FrozenVersionError("born_frozen");
            }
            return query(args);
          }

          if (model && FROZEN_CHILD_MODELS.has(model)) {
            const delegate = client[lowerFirst(model)]!;
            let ids: string[] = [];
            if (CREATE_OPS.has(operation)) {
              ids = versionIdsFromWriteData(a.data);
            } else {
              const select = { problemVersionId: true };
              const rows = UNIQUE_OPS.has(operation)
                ? [await delegate.findUnique({ where: a.where, select })].filter((r) => r !== null)
                : await delegate.findMany({ where: a.where ?? {}, select });
              ids = rows.map((r) => r.problemVersionId);
              if (operation === "upsert") {
                ids.push(...versionIdsFromWriteData(a.create), ...versionIdsFromWriteData(a.update));
              }
              if (a.data && !Array.isArray(a.data)) ids.push(...versionIdsFromWriteData(a.data));
            }
            await assertNoneFrozen(client, ids);
          }
          return query(args);
        },
      },
    },
  });
}
