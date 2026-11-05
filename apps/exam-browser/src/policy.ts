import { refusedSwitches } from "@recx/shared/exam-browser";
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
