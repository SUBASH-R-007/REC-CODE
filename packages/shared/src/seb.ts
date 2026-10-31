/**
 * Safe Exam Browser key verification (Phase 6d). Pure: the hash inputs, the
 * comparison and the refusal. The sha256 itself is passed in, so this module
 * stays free of node:crypto and is testable with a known digest.
 *
 * SPEC §5:
 *
 *   When proctorMode = KIOSK_SEB: recompute sha256(absoluteRequestUrl + key)
 *   for the session's sebConfigKey and sebBrowserExamKey and compare against
 *   X-SafeExamBrowser-ConfigKeyHash and X-SafeExamBrowser-RequestHash; 403
 *   SEB_REQUIRED on mismatch or absence, with an audit row. Keys live in
 *   PlatformSetting, rotate per exam session, and are never committed.
 *   Server-side key verification is the part most deployments skip and the
 *   part that matters.
 *
 * "The part most deployments skip" is the reason this exists as its own
 * tested module rather than four lines in a route: a deployment that ships
 * SEB without this check has a kiosk browser that any ordinary browser can
 * impersonate by visiting the same URL, and nothing about the product would
 * look wrong.
 *
 * What it is NOT: proof that SEB is running. A candidate who extracts the
 * keys from a .seb file can compute the headers themselves. It raises the
 * cost from "open Chrome" to "extract a key and forge two headers", which is
 * worth having and is all it is claimed to be (docs/PROCTORING.md).
 */

/** The headers SEB sends. Lower-case, as a Headers lookup returns them. */
export const SEB_CONFIG_KEY_HEADER = "x-safeexambrowser-configkeyhash";
export const SEB_REQUEST_HASH_HEADER = "x-safeexambrowser-requesthash";

/** Why a request was refused. A closed set, so each has a sentence and an audit action. */
export const SEB_REFUSALS = [
  /** No SEB headers at all: an ordinary browser. */
  "absent",
  /** Headers present, one or both wrong. */
  "mismatch",
  /** The exam session has no keys configured, so the check cannot run. */
  "not_configured",
] as const;
export type SebRefusal = (typeof SEB_REFUSALS)[number];

export const SEB_REFUSAL_MESSAGES: Readonly<Record<SebRefusal, string>> = Object.freeze({
  absent:
    "This assessment must be sat in Safe Exam Browser. Open the exam from the .seb file your department gave you.",
  mismatch:
    "Safe Exam Browser could not be verified for this assessment. Ask your invigilator for the current exam file.",
  not_configured:
    "This assessment is set to use Safe Exam Browser, but no exam keys have been configured. Tell your invigilator — this is a setup problem, not something you have done.",
});

export interface SebKeys {
  /** Identifies the configuration file. Hashes into the ConfigKeyHash header. */
  readonly configKey: string | null;
  /** Identifies the browser build. Hashes into the RequestHash header. */
  readonly browserExamKey: string | null;
}

export interface SebPresented {
  readonly configKeyHash: string | null;
  readonly requestHash: string | null;
}

export type SebVerdict =
  | { readonly ok: true; readonly checked: "config" | "browser" | "both" }
  | { readonly ok: false; readonly refusal: SebRefusal; readonly message: string };

/**
 * Compare the presented hashes against the recomputed ones.
 *
 * `sha256` is injected rather than imported, which keeps this module pure and
 * lets a test drive it with a known digest function instead of pre-computing
 * fixtures by hand.
 *
 * Both keys are optional on purpose: a deployment may configure one and not
 * the other (SEB's own documentation treats them as independent), and the
 * verdict says which were actually checked so an invigilator's screen can
 * show "config key verified" rather than an unqualified tick. If NEITHER is
 * configured the result is `not_configured` — refused, not waved through,
 * because an assessment set to KIOSK_SEB with no keys is a setup mistake and
 * silently accepting every browser is the one outcome nobody wants.
 */
export function verifySeb(args: {
  /** The absolute URL of the request, exactly as SEB saw it. */
  readonly absoluteUrl: string;
  readonly keys: SebKeys;
  readonly presented: SebPresented;
  readonly sha256: (text: string) => string;
}): SebVerdict {
  const { configKey, browserExamKey } = args.keys;
  if (!configKey && !browserExamKey) {
    return { ok: false, refusal: "not_configured", message: SEB_REFUSAL_MESSAGES.not_configured };
  }

  const wantedConfig = configKey ? args.sha256(args.absoluteUrl + configKey) : null;
  const wantedBrowser = browserExamKey ? args.sha256(args.absoluteUrl + browserExamKey) : null;

  const presentedConfig = normalise(args.presented.configKeyHash);
  const presentedBrowser = normalise(args.presented.requestHash);

  // No header for anything we are checking: an ordinary browser, which gets a
  // different sentence from a wrong hash because the thing to do about it is
  // different.
  const anyPresented = (wantedConfig !== null && presentedConfig !== null) || (wantedBrowser !== null && presentedBrowser !== null);
  if (!anyPresented) return { ok: false, refusal: "absent", message: SEB_REFUSAL_MESSAGES.absent };

  if (wantedConfig !== null && presentedConfig !== wantedConfig) {
    return { ok: false, refusal: "mismatch", message: SEB_REFUSAL_MESSAGES.mismatch };
  }
  if (wantedBrowser !== null && presentedBrowser !== wantedBrowser) {
    return { ok: false, refusal: "mismatch", message: SEB_REFUSAL_MESSAGES.mismatch };
  }

  const checked = wantedConfig !== null && wantedBrowser !== null ? "both" : wantedConfig !== null ? "config" : "browser";
  return { ok: true, checked };
}

/** SEB sends lower-case hex; a trimmed, lower-cased compare tolerates a proxy that re-cases it. */
function normalise(hash: string | null): string | null {
  if (hash === null) return null;
  const trimmed = hash.trim().toLowerCase();
  return trimmed === "" ? null : trimmed;
}

/**
 * The URL SEB hashes: the absolute request URL, with no query string and no
 * fragment.
 *
 * SEB hashes the URL the browser requested. A query string the client can
 * add would let it change the hash input at will, so it is dropped on both
 * sides — which also means a cache-busting parameter or a tracking parameter
 * appended by anything in the path cannot break a candidate's exam.
 */
export function sebUrlFor(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}
