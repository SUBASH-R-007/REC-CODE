import type { LanguageKey } from "@recx/shared";

/**
 * Links into the public /judge transparency page. Tiny and type-only on
 * @recx/shared, so the client workspace bundle that shows the footer link
 * carries nothing else.
 */

export const JUDGE_PAGE_PATH = "/judge";

/** The id of a language's heading on /judge ("lang-cpp20"). */
export function judgeLanguageAnchor(key: LanguageKey | string): string {
  return `lang-${key}`;
}

/** "/judge#lang-cpp20". */
export function judgeLanguageHref(key: LanguageKey | string): string {
  return `${JUDGE_PAGE_PATH}#${judgeLanguageAnchor(key)}`;
}

/**
 * The footer text for a language: its label, plus the exact version when
 * the label does not already carry it ("C++20 (GCC 13.2.0)" stays as is).
 */
export function formatLanguageVersion(label: string, version: string): string {
  const v = version.trim();
  return !v || label.includes(v) ? label : `${label} · ${v}`;
}
