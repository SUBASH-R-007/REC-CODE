import "server-only";

import { isLanguageKey, type LanguageKey } from "@recx/shared";
import { db } from "@/lib/db";

/**
 * The one language a sitting is answered in (Phase 6c).
 *
 * A paper gives every question the same editor and the same language: the
 * first enabled, current toolchain language by key, falling back to cpp20.
 * It is derived rather than stored, which is fine — and was a trap, because
 * it was derived in `getExamPaper` alone. Phase 12q.5 added a Run route
 * that has to validate the language a candidate's editor claims, and a
 * route re-deriving "the first enabled language" with its own copy of that
 * line is two places that must agree and will not: enable a language whose
 * key sorts earlier and the page would hand out one language while the
 * route accepted another, so every Run would be refused as "not the
 * language this paper is answered in" and nobody would know why.
 *
 * So it lives here, once, and both ask it.
 *
 * It is a per-request value, not a per-attempt one: the language is not
 * written into the layout, so a paper sat today and resumed after an
 * administrator enables a new toolchain can change language underneath the
 * candidate. That is a real hole and not this slice's to close — closing
 * it means putting the language in the layout where the frozen versions
 * already live (docs/OPEN-QUESTIONS.md, Phase 6c).
 */
export async function examPaperLanguage(): Promise<LanguageKey> {
  const configs = await db.languageConfig.findMany({
    where: { enabled: true, isCurrent: true },
    select: { key: true },
    orderBy: { key: "asc" },
  });
  return configs.map((c) => c.key).find(isLanguageKey) ?? "cpp20";
}
