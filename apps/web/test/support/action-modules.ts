import { readdirSync } from "node:fs";
import path from "node:path";

/**
 * Every server-action module (src/server/actions/*.ts) as [name, loader]
 * pairs, for the runtime sweeps (capability matrix, read-only
 * impersonation). Loaded through vitest, so the "@/" aliases and the
 * test's vi.mock() replacements apply.
 */
export const ACTIONS_DIR = path.resolve(__dirname, "../../src/server/actions");

export function actionModules(): Array<[string, () => Promise<Record<string, unknown>>]> {
  return readdirSync(ACTIONS_DIR)
    .filter((f) => f.endsWith(".ts"))
    .sort()
    .map((f) => [
      f.replace(/\.ts$/, ""),
      () => import(/* @vite-ignore */ path.join(ACTIONS_DIR, f)) as Promise<Record<string, unknown>>,
    ]);
}
