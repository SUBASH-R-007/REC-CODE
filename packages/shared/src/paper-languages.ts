import { LANGUAGE_CATALOG, LANGUAGE_KEYS, isLanguageKey, type LanguageKey } from "./languages";

/**
 * Which languages a paper may be answered in (Phase 13a).
 *
 * Until now a sitting had ONE language and nobody chose it: `cpp20`, or
 * whatever enabled toolchain key happened to sort first. A department
 * running a Python paper had no way to say so, a candidate who writes
 * Java sat down in front of a C++ editor, and the only lever anybody had
 * was enabling and disabling toolchains platform-wide — which changes
 * every other exam and every practice page at the same time.
 *
 * So an assessment now carries the set it accepts, and a candidate picks
 * one of them per question. Three rules, all of them here rather than at
 * the half-dozen places that ask:
 *
 *   1. **Empty means every enabled language.** A paper nobody has
 *      restricted is a paper with no restriction — not a paper nobody can
 *      sit. It is also what every assessment already in the database
 *      holds, so this module changes no stored meaning.
 *   2. **The catalog's order, never the order they were ticked in.** The
 *      list is shown to candidates mid-exam; it must not move around
 *      because an administrator re-saved it.
 *   3. **An accepted language that is not installed is not offered.** The
 *      admin's list is an intention; the `LanguageConfig` rows are what
 *      the judge can actually run, and the candidate is shown the
 *      intersection. A toolchain disabled between publishing a paper and
 *      sitting it must not produce an editor whose Run button refuses
 *      everything.
 *
 * Which are the paper's own languages and which are a candidate's is the
 * distinction the two functions below draw. `normalisePaperLanguages`
 * cleans what an administrator saved; `paperLanguages` is what a sitting
 * may use, and is the one every surface asks.
 */

/** The catalog's order, so `indexOf` below is the single ordering rule. */
const ORDER: readonly string[] = LANGUAGE_KEYS;

/**
 * Clean a stored or submitted list: known toolchain keys only, no
 * duplicates, in the catalog's order.
 *
 * Unknown keys are DROPPED rather than refused, because this also reads
 * rows written by an older build: a key retired from the catalog must not
 * make an existing paper unreadable. The action that writes the list
 * refuses an unknown key outright, which is where a typo belongs.
 */
export function normalisePaperLanguages(input: unknown): LanguageKey[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<LanguageKey>();
  for (const value of input) {
    if (isLanguageKey(value)) seen.add(value);
  }
  return [...seen].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
}

/**
 * The languages ONE sitting may be answered in.
 *
 * `allowed` is the assessment's own list (empty = no restriction) and
 * `available` is the enabled, current `LanguageConfig` keys. The result is
 * what the editor offers and what the run and submit paths accept, so
 * every one of them has to ask this and not reason about it themselves —
 * the Phase 12q.5 lesson, where a route re-deriving "the first enabled
 * language" with its own copy of that line refused every run on a paper
 * the page had handed out in a different language.
 *
 * Empty is a real answer: no toolchain is enabled at all, or every
 * language this paper accepts has been disabled since. The caller decides
 * what to do about it — `start` falls back to the derived single language
 * so a paper never becomes unsittable, and the readiness page says so.
 */
export function paperLanguages(args: {
  readonly allowed: unknown;
  readonly available: readonly string[];
}): LanguageKey[] {
  const installed = normalisePaperLanguages(args.available);
  const wanted = normalisePaperLanguages(args.allowed);
  if (wanted.length === 0) return installed;
  const offered = new Set(installed);
  return wanted.filter((key) => offered.has(key));
}

/**
 * Is this language one the sitting may be answered in?
 *
 * The question the run and submit paths ask of the FROZEN set in the
 * attempt's layout — never of the assessment's current list, which an
 * administrator may have changed since the candidate sat down.
 */
export function acceptsLanguage(accepted: readonly string[], language: string): boolean {
  return accepted.includes(language);
}

/**
 * What a candidate reads when the language they sent is not one of these.
 *
 * One sentence, naming what to do: the editor only ever offers the
 * accepted set, so anybody seeing this has a page older than the paper or
 * a client somebody has been editing.
 */
export const LANGUAGE_NOT_ACCEPTED_MESSAGE =
  "This paper is not answered in that language. Pick one from the language list above the editor and try again.";

/**
 * One accepted language, as a SCREEN is given it.
 *
 * Labels travel as data rather than as a function a client calls, and that
 * is a measured decision, not a style. `LANGUAGE_CATALOG` holds every
 * compiler argv, every environment variable and every limit for eleven
 * toolchains; a client component that calls `shortLanguageLabel` drags the
 * whole thing into the browser bundle, and into the SHARED chunk that
 * every budgeted route then loads. The first draft of this phase did
 * exactly that and the sitting's own budget was the thing that caught it:
 * `/assessments/[slug]/attempt` went 1.2 KB over, on an exam page that is
 * loaded on lab machines over a campus network.
 *
 * So the server resolves the labels and sends these. The catalog stays
 * where it belongs — on the server, beside the judge.
 */
export interface PaperLanguageView {
  readonly key: string;
  /** "C++20 (GCC 13.2.0)" — the full label, under the editor. */
  readonly label: string;
  /** "C++20" — for the dropdown. */
  readonly shortLabel: string;
  /** The editor's highlighting mode; never sent to a route. */
  readonly editorLanguage: string;
}

/** Build the views for a list of keys. Server-side: it reads the catalog. */
export function paperLanguageViews(keys: readonly string[]): PaperLanguageView[] {
  return keys.map((key) => ({
    key,
    label: paperLanguageLabel(key),
    shortLabel: shortLanguageLabel(key),
    editorLanguage: isLanguageKey(key) ? LANGUAGE_CATALOG[key].editorLanguage : "plaintext",
  }));
}

/** The label with its pinned toolchain, as the catalog writes it. */
export function paperLanguageLabel(key: string): string {
  return isLanguageKey(key) ? LANGUAGE_CATALOG[key].label : key;
}

/**
 * "C++20 (GCC 13.2.0)" → "C++20", for the picker inside a sitting.
 *
 * The full label belongs under the editor, where a candidate checking
 * which compiler they are being judged by can read it. In a dropdown it
 * is noise, and a dropdown wide enough for "Python 3.12 (CPython 3.12.6,
 * numpy 1.26.4)" is a dropdown that pushes the clock off a 1366-wide lab
 * screen.
 */
export function shortLanguageLabel(key: string): string {
  const label = paperLanguageLabel(key);
  const open = label.indexOf(" (");
  return open === -1 ? label : label.slice(0, open);
}
