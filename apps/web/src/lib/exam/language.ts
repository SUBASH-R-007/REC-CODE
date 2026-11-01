import "server-only";

import {
  isLanguageKey,
  normalisePaperLanguages,
  paperLanguages,
  type AttemptLayout,
  type LanguageKey,
} from "@recx/shared";
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
 * Phase 12r.4 closed the hole this used to carry. The language is now
 * frozen into the attempt's layout at start, where the frozen version ids
 * already live, so `languageOfSitting` below is what the exam surfaces
 * ask; this function is the derivation behind it, used when a paper is
 * first laid out and as the fallback for attempts begun before the field
 * existed.
 */
export async function examPaperLanguage(): Promise<LanguageKey> {
  const configs = await db.languageConfig.findMany({
    where: { enabled: true, isCurrent: true },
    select: { key: true },
    orderBy: { key: "asc" },
  });
  return configs.map((c) => c.key).find(isLanguageKey) ?? "cpp20";
}

/**
 * The language ONE SITTING is answered in.
 *
 * The frozen value from the layout, or the derivation above for an attempt
 * begun before the field existed. Every exam surface asks this rather than
 * deriving its own: the editor's starter code, the submission's language
 * and the Run route's validation all have to agree, and they agree because
 * they read the same frozen string.
 */
export async function languageOfSitting(layout: Pick<AttemptLayout, "language">): Promise<LanguageKey> {
  const frozen = layout.language;
  if (frozen !== undefined && isLanguageKey(frozen)) return frozen;
  return examPaperLanguage();
}

/**
 * The languages ONE SITTING may be answered in (Phase 13a).
 *
 * The frozen set from the layout, and for an attempt begun before that
 * field existed, the single frozen language — which is exactly what those
 * sittings allowed. Every exam path asks this: the paper the editor is
 * drawn from, the snapshot route, the Run route and the submit. One
 * derivation, because the alternative is what Phase 12q.5 found when a
 * route re-derived "the first enabled language" with its own copy of that
 * line and refused every run on a paper the page had handed out in a
 * different language.
 *
 * Never the assessment's CURRENT list. A department may widen or narrow
 * `Assessment.allowedLanguages` at any time, including while a hall is
 * sitting; what this candidate may answer in was decided when their paper
 * was laid out.
 */
export async function languagesOfSitting(
  layout: Pick<AttemptLayout, "language" | "languages">,
): Promise<LanguageKey[]> {
  const frozen = normalisePaperLanguages(layout.languages);
  if (frozen.length > 0) return frozen;
  return [await languageOfSitting(layout)];
}

/**
 * The accepted set for a paper about to be laid out: what the department
 * chose, narrowed to what the judge can actually run.
 *
 * Empty from `paperLanguages` means either nothing is enabled at all or
 * every language this paper accepts has since been disabled. Neither is
 * the candidate's fault and neither should make a paper unsittable, so the
 * fallback is the derivation this product used before any of this existed:
 * one language, the first enabled, `cpp20` if there is nothing else. The
 * readiness page and `/admin/judge` are where that condition is visible.
 */
export async function acceptedLanguagesFor(allowed: readonly string[]): Promise<LanguageKey[]> {
  const installed = await db.languageConfig.findMany({
    where: { enabled: true, isCurrent: true },
    select: { key: true },
  });
  const offered = paperLanguages({ allowed, available: installed.map((row) => row.key) });
  if (offered.length > 0) return offered;
  return [await examPaperLanguage()];
}
