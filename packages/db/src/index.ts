import { PrismaClient } from "@prisma/client";
import { frozenVersionGuard } from "./frozen";

export * from "@prisma/client";
export {
  BORN_FROZEN_MESSAGE,
  FROZEN_CHILD_MODELS,
  FROZEN_EXEMPT_MODELS,
  FROZEN_VERSION_MESSAGE,
  FrozenVersionError,
  type FrozenVersionErrorCode,
} from "./frozen";

export interface CreateClientOptions {
  /** Override the datasource URL (e.g. DATABASE_URL_DIRECT for the scheduler). */
  url?: string;
  log?: ("query" | "info" | "warn" | "error")[];
}

/**
 * The only way REC Code processes obtain a database client. Every client is
 * wrapped with the frozen-version guard. apps/judge-worker must never import
 * this package (enforced by lint and tests/repo/judge-isolation.test.ts).
 */
export function createPrismaClient(options: CreateClientOptions = {}) {
  const base = new PrismaClient({
    log: options.log ?? ["error"],
    ...(options.url ? { datasources: { db: { url: options.url } } } : {}),
  });
  // The guard needs an UNEXTENDED client for its lookups, or every lookup
  // would recurse through the guard itself.
  return base.$extends(frozenVersionGuard(() => base as never));
}

export type Db = ReturnType<typeof createPrismaClient>;
/** The transaction client handed to `db.$transaction(async (tx) => …)`. */
export type DbTx = Parameters<Parameters<Db["$transaction"]>[0]>[0];
