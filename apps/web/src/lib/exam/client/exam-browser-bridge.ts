/**
 * What the exam page may ask REC Exam Browser (Phase 14d).
 *
 * The preload (`apps/exam-browser/src/preload.ts`) exposes three things on
 * `window`, and this is the typed way the page reaches them. It is a
 * client module on purpose and holds no secret: the sitting key lives in
 * the application's main process and never crosses into the renderer, so
 * there is nothing here for a candidate's own JavaScript to take.
 *
 * Everything is optional and everything has a fallback. The same page runs
 * in an ordinary browser for every other proctor mode, and a page that
 * assumed the bridge was there would break for the majority of sittings.
 */

interface ExamBrowserBridge {
  readonly version: () => Promise<string>;
  readonly displays: () => Promise<number>;
  readonly finish: () => void;
}

function bridge(): ExamBrowserBridge | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as unknown as { recxExamBrowser?: unknown }).recxExamBrowser;
  if (!candidate || typeof candidate !== "object") return null;
  const maybe = candidate as Partial<ExamBrowserBridge>;
  return typeof maybe.displays === "function" && typeof maybe.version === "function"
    ? (candidate as ExamBrowserBridge)
    : null;
}

/** True when this page is being rendered inside REC Exam Browser. */
export function inExamBrowser(): boolean {
  return bridge() !== null;
}

/**
 * How many displays are attached, or null when nothing can say.
 *
 * `docs/PROCTORING.md` §2: a web page cannot do this. `screen.isExtended`
 * is Chromium-only, its absence means nothing, and it is trivially
 * falsified by a content script that runs before any page script. The
 * desktop application asks the operating system, which is one of the few
 * things it genuinely knows that a page does not
 * (`docs/EXAM-BROWSER.md` §3).
 *
 * Null rather than a guess when there is no bridge: the caller falls back
 * to the unreliable hint and the two are not conflated.
 */
export async function displayCount(): Promise<number | null> {
  const api = bridge();
  if (!api) return null;
  try {
    const count = await api.displays();
    return Number.isFinite(count) && count > 0 ? Math.floor(count) : null;
  } catch {
    return null;
  }
}
