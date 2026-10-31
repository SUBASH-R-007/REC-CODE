import { hydrateFileBackedSecrets } from "@recx/shared/env-file";
import { createPrismaClient, type Db } from "@recx/db";

/**
 * The ONE database client of this server process (pooled URL), kept on
 * globalThis — in production too. Next bundles server code per layer (React
 * Server Components, server-side rendering, route handlers, the Pages
 * Router's sign-in page), and each layer that evaluates a module importing
 * this gets its own copy of the module; the global slot makes them all share
 * a single client and so a single connection pool. In development the slot
 * also survives hot reloads.
 *
 * Server code only. Import it through src/lib/db.ts (which adds the
 * `server-only` guard); the sole direct importer is src/lib/pages-server.ts,
 * because Next refuses `server-only` anywhere in a pages/ import graph.
 */
const globalForDb = globalThis as unknown as { recxDb?: Db };

export function processDb(): Db {
  // Prisma resolves DATABASE_URL from the environment as the client is
  // constructed, so a URL that arrived as DATABASE_URL_FILE has to be in
  // place BEFORE this line — and this is the only line in the application
  // that constructs a client (@recx/shared/env-file, docs/RUNBOOK.md §2.14).
  hydrateFileBackedSecrets(["DATABASE_URL"]);
  globalForDb.recxDb ??= createPrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
  return globalForDb.recxDb;
}
