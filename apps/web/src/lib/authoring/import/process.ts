import "server-only";
import { unlink } from "node:fs/promises";
import { ArchiveError, openZipArchive } from "./archive";
import { auditImportCompleted, failImport, runProblemImport } from "./run";

/**
 * The background half of an upload (run in `after()` once the 202 is sent):
 * open the spooled zip, import every problem directory, audit the result,
 * and always remove the spool file. A whole-archive failure (not a zip, over
 * a cap) marks the import FAILED with the reason; per-entry failures are
 * rows. Never throws.
 */
export async function processSpooledImport(
  importId: string,
  spoolPath: string,
  actor: { actorId: string; via: string; ipHash?: string | null },
): Promise<void> {
  try {
    const archive = await openZipArchive(spoolPath);
    const results = await runProblemImport(importId, archive, actor.actorId);
    await auditImportCompleted(importId, actor, results);
  } catch (error) {
    if (error instanceof ArchiveError) await failImport(importId, error.message).catch(() => undefined);
    else {
      console.error(`[import] ${importId} failed:`, error);
      await failImport(importId, "The import stopped on an unexpected error. Re-upload the archive to resume.").catch(() => undefined);
    }
  } finally {
    await unlink(spoolPath).catch(() => undefined);
  }
}
