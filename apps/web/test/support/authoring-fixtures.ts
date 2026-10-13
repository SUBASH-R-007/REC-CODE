import { LANGUAGE_CATALOG } from "@recx/shared";
import type { Db } from "@recx/db";

/**
 * Database fixtures shared by the authoring DB tests (problem-authoring,
 * problem-publish-concurrency, problem-import). Every row carries the test's
 * own tag; teardown deletes only those rows, lifting the frozen-version
 * triggers inside one transaction and re-enabling them before it commits.
 */

/** The same lock order as the other suites' teardowns (judge-pipeline): children first, ProblemVersion last. */
export const FROZEN_GUARDED = [
  "TestCase",
  "StarterCode",
  "ReferenceSolution",
  "Subtask",
  "ProblemLanguageLimit",
  "Hint",
  "Editorial",
  "ProblemVersion",
] as const;

/** Web DB suites run in parallel; a teardown can be picked as a deadlock victim. It is idempotent, so retry it. */
async function retryDeadlock<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (attempt >= 6 || !/40P01|deadlock detected/.test(message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt + Math.floor(Math.random() * 100)));
    }
  }
}

export interface TestStore {
  driver: "local";
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  stream(key: string): Promise<ReadableStream<Uint8Array>>;
}

/** An in-memory write-once store with the TestDataStore contract (put of different bytes throws). */
export function memoryStore(objects = new Map<string, Buffer>()): TestStore & { objects: Map<string, Buffer> } {
  return {
    driver: "local",
    objects,
    async put(key, bytes) {
      const seen = objects.get(key);
      if (seen && !seen.equals(bytes)) throw new Error(`ImmutableKeyError: ${key}`);
      objects.set(key, Buffer.from(bytes));
    },
    async get(key) {
      const bytes = objects.get(key);
      if (!bytes) throw new Error(`missing ${key}`);
      return bytes;
    },
    async exists(key) {
      return objects.has(key);
    },
    async stream(key) {
      return new Blob([new Uint8Array(objects.get(key) ?? Buffer.alloc(0))]).stream();
    },
  };
}

/** Enabled, current LanguageConfig rows for cpp20 and py312 (upserted by catalog key, shared across test files). */
export async function enableLanguages(db: Db, keys: readonly ("cpp20" | "py312")[] = ["cpp20", "py312"]): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const key of keys) {
    const rt = LANGUAGE_CATALOG[key];
    const fields = { label: rt.label, version: rt.version, runtime: JSON.parse(JSON.stringify(rt)), enabled: true, isCurrent: true };
    const row = await db.languageConfig.upsert({
      where: { key_toolchainId: { key, toolchainId: rt.toolchainId } },
      create: { key, toolchainId: rt.toolchainId, ...fields },
      update: fields,
      select: { id: true },
    });
    ids[key] = row.id;
  }
  return ids;
}

export async function createUser(db: Db, tag: string, name: string, role: "ADMIN" | "SUPER_ADMIN" | "STUDENT"): Promise<{ id: string; role: string }> {
  const handle = `${tag}-${name}`.toLowerCase().slice(0, 40);
  const user = await db.user.create({
    data: {
      collegeId: `${tag}-${name}`.slice(0, 60),
      email: `${handle}@rec-code.example`,
      firstName: name,
      lastName: "Tester",
      handle,
      role,
    },
    select: { id: true, role: true },
  });
  return user;
}

/** Remove every row a test created for its problems, users and blobs. */
export async function cleanup(db: Db, input: { problemIds: string[]; userIds: string[]; blobShas: string[]; importIds?: string[] }): Promise<void> {
  const scope = `SELECT "id" FROM "ProblemVersion" WHERE "problemId" = ANY($1::text[])`;
  const ids = input.problemIds;
  await retryDeadlock(() => db.$transaction([
    ...FROZEN_GUARDED.map((t) => db.$executeRawUnsafe(`ALTER TABLE "${t}" DISABLE TRIGGER "${t}_frozen_guard"`)),
    db.$executeRawUnsafe(`DELETE FROM "ValidationRun" WHERE "problemVersionId" IN (${scope})`, ids),
    db.$executeRawUnsafe(`DELETE FROM "Submission" WHERE "problemId" = ANY($1::text[])`, ids),
    db.$executeRawUnsafe(`DELETE FROM "ProblemStat" WHERE "problemId" = ANY($1::text[])`, ids),
    ...["ProblemLanguageLimit", "Subtask", "TestCase", "StarterCode", "ReferenceSolution", "Hint", "Editorial"].map((t) =>
      db.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "problemVersionId" IN (${scope})`, ids),
    ),
    db.$executeRawUnsafe(`UPDATE "Problem" SET "liveVersionId" = NULL WHERE "id" = ANY($1::text[])`, ids),
    db.$executeRawUnsafe(`DELETE FROM "ProblemVersion" WHERE "problemId" = ANY($1::text[])`, ids),
    db.$executeRawUnsafe(`DELETE FROM "Problem" WHERE "id" = ANY($1::text[])`, ids),
    db.$executeRawUnsafe(`DELETE FROM "ProblemImport" WHERE "id" = ANY($1::text[])`, input.importIds ?? []),
    ...FROZEN_GUARDED.map((t) => db.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE TRIGGER "${t}_frozen_guard"`)),
  ]));
  if (input.blobShas.length > 0) {
    await db.testBlob.deleteMany({ where: { sha256: { in: input.blobShas }, asInput: { none: {} }, asOutput: { none: {} } } });
  }
  if (input.userIds.length > 0) {
    await db.$executeRawUnsafe(`DELETE FROM "UserJudgeUsage" WHERE "userId" = ANY($1::text[])`, input.userIds);
    await db.user.deleteMany({ where: { id: { in: input.userIds } } });
  }
  const disabled = await db.$queryRawUnsafe<{ tgname: string }[]>(
    `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgenabled <> 'O' AND tgname LIKE '%frozen_guard'`,
  );
  if (disabled.length > 0) throw new Error(`Triggers left disabled: ${disabled.map((r) => r.tgname).join(", ")}`);
}
