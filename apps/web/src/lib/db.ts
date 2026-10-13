import "server-only";
import type { Db } from "@recx/db";
import { processDb } from "@/lib/db-client";

/**
 * The web app's database client (pooled URL). Server components fetch with it
 * directly; mutations go through server actions in src/server/actions/*.
 * One client per process, shared with the Pages Router sign-in page through
 * src/lib/db-client.ts.
 */
export const db: Db = processDb();
