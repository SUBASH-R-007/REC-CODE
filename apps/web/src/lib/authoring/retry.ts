import "server-only";
import { Prisma, type DbTx } from "@recx/db";
import { db } from "@/lib/db";

/**
 * Postgres aborted the transaction as a deadlock victim (40P01) or a
 * serialization failure (40001). The whole transaction rolled back, so
 * running it again is safe. Prisma surfaces these as P2034 or as an unknown
 * request error carrying the SQLSTATE in its message.
 */
export function isTransientDbError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") return true;
  const message = error instanceof Error ? error.message : "";
  return /\b40P01\b|\b40001\b|deadlock detected|could not serialize access/.test(message);
}

/**
 * Run a whole transaction again (up to `attempts` times in all) when
 * Postgres aborted it as a deadlock victim. Only ever wrap a complete
 * `db.$transaction(...)`, never work that already committed something.
 */
export async function withTransientRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts || !isTransientDbError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt + Math.floor(Math.random() * 25)));
    }
  }
}

/** `db.$transaction(fn, options)`, run again when Postgres aborted it as a deadlock victim. */
export function retryingTransaction<T>(fn: (tx: DbTx) => Promise<T>, options?: { timeout?: number; maxWait?: number }): Promise<T> {
  return withTransientRetry(() => db.$transaction(fn, options));
}
