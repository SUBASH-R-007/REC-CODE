import "server-only";
import { revalidateTag, unstable_cache } from "next/cache";
import { db } from "@/lib/db";
import type { PublicLanguageRow } from "@/lib/judge/transparency";

export type { PublicLanguageRow } from "@/lib/judge/transparency";

/** Cache tag of the public language list (/judge and /help). */
export const LANGUAGE_CONFIG_TAG = "language-config";

/**
 * The enabled, current LanguageConfig rows: the toolchains a submission can
 * be judged with right now, with the runtime JSON the worker receives at
 * claim time. Public facts only: no user, node, problem or test data.
 *
 * Cached across requests. Every LanguageConfig write calls
 * revalidateLanguageConfigs(); the 60-second backstop covers the seed and
 * any writer that does not. A database failure throws out of here, and
 * unstable_cache never caches a throw.
 */
export const getPublicLanguageRows: () => Promise<PublicLanguageRow[]> = unstable_cache(
  async (): Promise<PublicLanguageRow[]> =>
    db.languageConfig.findMany({
      where: { enabled: true, isCurrent: true },
      select: { key: true, label: true, version: true, toolchainId: true, runtime: true },
      orderBy: { key: "asc" },
    }),
  ["judge-public-languages", "v1"],
  { tags: [LANGUAGE_CONFIG_TAG], revalidate: 60 },
);

/**
 * Call after any LanguageConfig write so /judge and /help pick it up on the
 * next request. Best effort: the write has already committed (and been
 * audited) when this runs, so a failure to revalidate is logged, never
 * reported as a failed write — the 60-second backstop still applies.
 */
export function revalidateLanguageConfigs(): void {
  try {
    revalidateTag(LANGUAGE_CONFIG_TAG);
  } catch (error) {
    console.warn("[judge] could not revalidate the public language list:", error instanceof Error ? error.message : error);
  }
}
