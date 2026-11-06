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

/**
 * The origins a release build may be launched against.
 *
 * A college cutting its own build changes THIS LIST and nothing else, then
 * signs the result. Leaving it at another college's hostname produces a
 * build that refuses every launch in the hall with "this launch pointed
 * somewhere this exam browser is not allowed to go", which is the failure
 * working but is a miserable way to discover it an hour before a paper.
 * `docs/EXAM-BROWSER.md` section 8 says so beside the release steps.
 */
export const RELEASE_ORIGINS: readonly string[] = Object.freeze([
  "https://code.rec.edu.in",
]);

/**
 * Which kind of build this is.
 *
 * A release build is the one a college publishes and a candidate installs.
 * A development build is the one this repository builds to point at a
 * laptop, and the difference is visible in four places on purpose: a
 * different application id, a different name in the Start menu, a
 * different installer filename, and a dialog the person has to dismiss
 * before the window opens. A development build that looked like a release
 * build would be the phishing risk this whole file exists to close.
 */
export type BuildChannel = "release" | "development";

export interface BuildIdentity {
  readonly channel: BuildChannel;
  /** Extra origins compiled into a DEVELOPMENT build. Empty in a release. */
  readonly origins: readonly string[];
}

/** The safe answer, used whenever the baked value is missing or unreadable. */
export const RELEASE_BUILD: BuildIdentity = Object.freeze({ channel: "release", origins: Object.freeze([]) });

/**
 * Written into the bundle by `tsup.config.ts`, which always defines it --
 * as a release with no extra origins unless the build was asked for a
 * development one.
 *
 * It is a compiled constant rather than anything read at runtime, and the
 * reader below falls to `RELEASE_BUILD` whenever it is missing or not the
 * shape it should be. Both halves matter: the first is why a signed build
 * cannot be widened by whoever starts it, and the second is why a bundler
 * misconfiguration produces a build that is too STRICT rather than one
 * that quietly trusts an attacker's server. The tests run this file
 * unbundled, where the constant does not exist at all, which is the same
 * path.
 */
declare const __RECX_BUILD__: unknown;

/**
 * Exported because it is the parser standing between a compiled constant
 * and the allowlist, and a parser nobody can call is a parser nobody
 * tests. Every answer but a well-formed development bake is
 * `RELEASE_BUILD`.
 */
export function readBakedBuild(value: unknown): BuildIdentity {
  if (typeof value !== "object" || value === null) return RELEASE_BUILD;
  const record = value as { channel?: unknown; origins?: unknown };
  if (record.channel !== "development") return RELEASE_BUILD;
  const origins = Array.isArray(record.origins) ? record.origins : [];
  const usable: string[] = [];
  for (const entry of origins) {
    if (typeof entry !== "string") continue;
    try {
      // Normalised through URL so a trailing path or a typo cannot widen
      // anything: only the origin survives.
      usable.push(new URL(entry).origin);
    } catch {
      // An unreadable entry is dropped rather than failing the start: the
      // build still has RELEASE_ORIGINS and refuses everything else.
    }
  }
  return Object.freeze({ channel: "development" as const, origins: Object.freeze(usable) });
}

/** What kind of build this is, read once from the compiled constant. */
export function buildIdentity(): BuildIdentity {
  return typeof __RECX_BUILD__ === "undefined" ? RELEASE_BUILD : readBakedBuild(__RECX_BUILD__);
}

/**
 * What a development build says before it opens anything. It is a dialog
 * rather than a line in a log because the person who most needs to read it
 * is the one who installed it by accident.
 */
export const DEVELOPMENT_BUILD_WARNING = Object.freeze({
  title: "REC Exam Browser (development build)",
  message: "This is a development build. It is not for sitting a real exam.",
  detail:
    "It can be pointed at servers other than your college's, so nothing it shows you is proof of anything. " +
    "If you are a candidate and you did not install this on purpose, uninstall it and install REC Exam Browser " +
    "from your college's own site instead.",
});

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
