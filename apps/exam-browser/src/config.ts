/**
 * What this build is, and the one place it is allowed to talk to.
 *
 * Both are compiled in rather than read from a file beside the executable,
 * and that is the security property rather than a convenience. A custom
 * scheme is registered system-wide, so any web page the candidate visits
 * can open `recx-exam://launch?origin=…`. If the origin came from the
 * launch URL alone, a page could start the college's own signed
 * application pointed at a server that page controls — a window with no
 * address bar, wearing the college's name, asking for a college password.
 * `parseExamBrowserLaunchUrl` refuses any origin not in this list, so the
 * worst such a page can do is start the browser on the real exam.
 *
 * A college therefore gets a build of its own. That is the cost, and it is
 * the right way round: changing where the exam browser may point should
 * require a signed release, not a text file a candidate can edit.
 */

/**
 * Read from the environment ONLY in development, so this repository's own
 * laptops can point at localhost without a rebuild. A packaged build has
 * `app.isPackaged` true and never consults it — `allowedOrigins()` in
 * `policy.ts` is where that is enforced, and a test holds it.
 */
export const DEV_ORIGIN_VARIABLE = "RECX_EXAM_DEV_ORIGIN";

/** The origins a release build may be launched against. */
export const RELEASE_ORIGINS: readonly string[] = Object.freeze([
  "https://code.rec.edu.in",
]);

/**
 * Kept in step with `package.json` by `test/config.test.ts`. It is sent on
 * every request and compared against the deployment's floor, so a build
 * that lied about its version would be a build that could not be cut off.
 */
export const APP_VERSION = "1.0.0";

/** Where the candidate lands after exchanging the launch token. */
export function readinessPath(assessmentSlug: string): string {
  return `/assessments/${assessmentSlug}/readiness`;
}

/**
 * The window. Fullscreen and frameless, with no menu: there is no address
 * bar to type into, no tab strip, and nothing to navigate with but the
 * page itself.
 */
export const WINDOW = Object.freeze({
  backgroundColor: "#0b0d10",
  minWidth: 1024,
  minHeight: 700,
});
