import { RECX_SESSION_COOKIE, refusedSwitches } from "@recx/shared/exam-browser";
import { DEV_ORIGIN_VARIABLE, RELEASE_ORIGINS } from "./config";

/**
 * Every decision the application makes, as functions over plain values.
 *
 * None of this imports `electron`. That is deliberate: a rule that can only
 * be exercised by starting a browser is a rule nobody tests, and the rules
 * here are the ones that matter — which origin may be loaded, which
 * requests carry the attestation, what the command line may contain, and
 * what a permission request gets. `main.ts` is wiring that calls into this
 * and does nothing else of consequence.
 */

/**
 * The origins this build may be launched against.
 *
 * A packaged build uses the compiled list and nothing else. Development
 * may add one from the environment, because this repository's own laptops
 * point at `http://localhost:3000` and rebuilding for that would mean the
 * developer build and the release build differed in more than one place.
 */
export function allowedOrigins(args: {
  readonly packaged: boolean;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): readonly string[] {
  if (args.packaged) return RELEASE_ORIGINS;
  const extra = args.environment?.[DEV_ORIGIN_VARIABLE]?.trim();
  if (!extra) return RELEASE_ORIGINS;
  try {
    return Object.freeze([new URL(extra).origin, ...RELEASE_ORIGINS]);
  } catch {
    return RELEASE_ORIGINS;
  }
}

/** Is this URL on the origin the sitting is being sat against? */
export function isExamOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

/**
 * The partition the sitting's window runs in (Phase 14g).
 *
 * No `persist:` prefix, and that is the whole point: in Electron a
 * partition without it is an IN-MEMORY session. Its cookies, its cache, its
 * local storage and its service workers live in this process and die with
 * it, so nothing the sitting touches is written beside the executable or
 * into the user data directory.
 *
 * That matters more here than it would in an ordinary application, because
 * from this slice on the window holds a real session cookie for the
 * candidate's account. On the default session that cookie would be written
 * to disk and would still be there tomorrow, which would turn
 * `docs/EXAM-BROWSER.md` §4's "leaves nothing behind" into a sentence that
 * was no longer true -- and would leave a credential on a shared machine.
 *
 * `tests/repo/exam-browser-posture.test.ts` checks that no `persist:`
 * partition and no use of the default session ever appears in this
 * application.
 */
export const EXAM_PARTITION = "recx-sitting";

/**
 * The cookie that carries the sitting's session, as a plain object.
 *
 * Built here rather than inline in `main.ts` so the parts that matter can
 * be tested without an Electron runtime: that it is `httpOnly`, that
 * `secure` follows the scheme rather than being hardcoded either way, and
 * that an expiry which is not a future moment is left off entirely instead
 * of being passed through.
 *
 * `secure` cannot simply be true: Chromium refuses a Secure cookie on an
 * `http://` URL, and this repository's own development origin is
 * `http://localhost:3000`. Hardcoding it false would be worse -- a release
 * build talks to https and a session cookie without Secure is one that
 * leaks over a downgrade -- so it follows the origin, and the origin is
 * already checked against this build's allowlist before anything reaches
 * here (`parseExamBrowserLaunchUrl`).
 */
export interface SessionCookieSpec {
  readonly url: string;
  readonly name: string;
  readonly value: string;
  readonly httpOnly: true;
  readonly secure: boolean;
  readonly sameSite: "lax";
  readonly path: "/";
  readonly expirationDate?: number;
}

export function sessionCookieFor(args: {
  readonly origin: string;
  readonly token: string;
  readonly expiresAtMs: number;
}): SessionCookieSpec {
  const base = {
    url: args.origin,
    name: RECX_SESSION_COOKIE,
    value: args.token,
    // Never readable by page script. The page inside this window is the one
    // place a candidate can run their own JavaScript, and the sitting's
    // session is not something it should be able to read out and carry
    // somewhere else.
    httpOnly: true as const,
    secure: args.origin.startsWith("https://"),
    sameSite: "lax" as const,
    path: "/" as const,
  };
  const seconds = args.expiresAtMs / 1000;
  /**
   * A cookie with no expiry is a session cookie, which in an in-memory
   * partition dies with the process. So an unusable expiry is left off
   * rather than passed on: the server's own session row is the real bound,
   * and a date in the past would make Chromium drop the cookie instantly
   * and send the candidate to the sign-in form.
   */
  if (!Number.isFinite(seconds) || seconds <= Date.now() / 1000) return base;
  return { ...base, expirationDate: Math.floor(seconds) };
}

export type NavigationDecision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: "off_origin" | "unparseable" };

/**
 * May the window navigate here?
 *
 * Everything that is not the exam origin is refused, including the schemes
 * a page can use to leave the browser entirely. `mailto:` and friends hand
 * the URL to the operating system, which opens another application over a
 * sitting in progress — the one way a page inside a kiosk window can still
 * put something else on the candidate's screen.
 */
export function navigationDecision(url: string, origin: string): NavigationDecision {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allow: false, reason: "unparseable" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { allow: false, reason: "off_origin" };
  }
  return isExamOrigin(url, origin) ? { allow: true } : { allow: false, reason: "off_origin" };
}

/**
 * Which permissions a page inside the exam browser may be granted:
 * **none**.
 *
 * Written as a function returning false rather than as an inline `() =>
 * false` so the test below is about a rule, and so the list of things it
 * refuses is written down where somebody adding one has to delete a
 * sentence to do it. `docs/PROCTORING.md` §5 forbids the camera, the
 * microphone and screen capture by name; the rest follow from a window
 * that exists to show one paper.
 */
export const REFUSED_PERMISSIONS: readonly string[] = Object.freeze([
  "media",
  "display-capture",
  "geolocation",
  "notifications",
  "midi",
  "midiSysex",
  "pointerLock",
  "fullscreen",
  "openExternal",
  "clipboard-read",
  "clipboard-sanitized-write",
  "hid",
  "serial",
  "usb",
  "bluetooth",
  "idle-detection",
  "window-management",
  "storage-access",
  "speaker-selection",
]);

export function permissionDecision(_permission: string): boolean {
  return false;
}

/**
 * Should this request carry the attestation headers?
 *
 * Only requests to the exam origin. An attestation is a credential, and a
 * credential attached to a request going anywhere else is a credential
 * handed to whoever is there — the same mistake as a bearer token on a
 * cross-origin fetch. In practice nothing else should be reachable at all
 * (`navigationDecision` refuses it), which makes this the second of two
 * locks on the same door rather than the only one.
 */
export function shouldAttest(url: string, origin: string): boolean {
  return isExamOrigin(url, origin);
}

/**
 * Keys the window swallows (Phase 14j).
 *
 * Window-scoped, through `before-input-event`, and that distinction is the
 * rule rather than an implementation detail: `docs/EXAM-BROWSER.md` §7
 * forbids a global input hook, because a kiosk browser that reads the
 * keyboard while it does not have focus is a keylogger whatever it is
 * called. These fire only for key presses Chromium is delivering to our
 * own focused window, and nothing is recorded — the key is dropped, not
 * written down.
 *
 * What is here, and why each one:
 *
 *   * **devtools** — the window is built with `devTools: false`, so these
 *     already do nothing. Swallowed anyway, because the next person to
 *     relax one option should have to delete two things;
 *   * **new window, new tab, close** — there is one window and it belongs
 *     to one sitting;
 *   * **print and save** — both write the paper somewhere the sitting does
 *     not reach. The questions are the college's;
 *   * **open file** — a file picker is another application's window on top
 *     of the paper;
 *   * **view source** — not a leak, but it opens a second view of the
 *     page that none of the rules above apply to;
 *   * **fullscreen toggle** — the window chooses its own, and a candidate
 *     who leaves fullscreen by accident has to be put back by hand.
 *
 * What is deliberately NOT here:
 *
 *   * **reload.** A candidate whose page has wedged needs it, and the exam
 *     page snapshots answers continuously, so a reload costs nothing. A
 *     kiosk that cannot recover is a kiosk that ends somebody's paper;
 *   * **copy, cut, paste.** `docs/PROCTORING.md` §2 settled this before
 *     this application existed: paste is instrumented, not blocked;
 *   * **zoom.** It is an accessibility control;
 *   * **Escape.** The editor uses it.
 */
export interface KeyChord {
  readonly key: string;
  readonly control: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

export function blockedChord(input: KeyChord): boolean {
  const key = input.key.toLowerCase();
  // Control on Windows and Linux, Command on macOS: one flag, because
  // every entry below is the same shortcut on both.
  const mod = input.control || input.meta;

  if (key === "f12" || key === "f11") return true;
  if (mod && input.shift && ["i", "j", "c"].includes(key)) return true;
  if (mod && ["n", "t", "w", "p", "s", "o", "u"].includes(key)) return true;
  if (mod && input.shift && ["n", "t", "w"].includes(key)) return true;
  return false;
}

export type StartupRefusal =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "refused_switches"; readonly switches: readonly string[] };

/**
 * May the application start with this command line?
 *
 * The first attack on a kiosk browser is not subtle: launch the college's
 * own binary from a shell with `--remote-debugging-port` and drive the
 * paper over DevTools Protocol from another machine, or `--load-extension`
 * the content script that lies about focus (`docs/PROCTORING.md` §2).
 * Electron honours Chromium's switches, so the binary refuses them itself
 * — before `app.whenReady()`, because by then the switch has already had
 * its effect.
 *
 * It refuses rather than ignores. Stripping the switch and carrying on
 * would leave a candidate sitting a paper in a browser whose guarantees
 * quietly differ from the one the invigilator thinks is running.
 */
export function startupDecision(argv: readonly string[]): StartupRefusal {
  const refused = refusedSwitches(argv);
  return refused.length === 0 ? { ok: true } : { ok: false, reason: "refused_switches", switches: refused };
}

/**
 * How many displays is too many.
 *
 * `docs/PROCTORING.md` §2 says a web page cannot reliably count displays;
 * a desktop application can, and this is one of the few things the exam
 * browser genuinely knows that a page does not. What it does with the
 * answer is report it — `docs/PROCTORING.md` §3 holds for everything the
 * browser sees, so a second monitor is a line a reviewer reads, never a
 * refusal to let somebody sit the paper.
 */
export function displayReport(count: number): { readonly extra: number; readonly worthReporting: boolean } {
  const extra = Math.max(0, count - 1);
  return { extra, worthReporting: extra > 0 };
}
