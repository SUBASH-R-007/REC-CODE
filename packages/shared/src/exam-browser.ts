/**
 * REC Exam Browser attestation (Phase 14a). Pure: the headers, the string
 * that gets signed, the comparison and the refusal. The HMAC itself is
 * passed in, so this module stays free of node:crypto and runs unchanged in
 * the Electron main process and in the web server.
 *
 * `docs/EXAM-BROWSER.md` §5 is the design and §6 is what it may be claimed
 * to be worth. The short version of both:
 *
 *   Safe Exam Browser's weakness is structural — one configuration key,
 *   shared by every candidate in a `.seb` file, often for a whole term.
 *   Extract it once and you can forge the headers for every paper the
 *   college sets. So this does not copy it. A sitting key is minted for one
 *   attempt, held in memory, and never written to disk at either end.
 *
 *   What that buys is bounded and worth saying out loud: a key read out of
 *   one sitting is worth that one sitting, which the server is already
 *   watching. It is not proof that the exam browser is running. A candidate
 *   with a debugger can read the key out of the process they own and sign
 *   their own requests. It raises the cost from "copy a file once" to
 *   "attack each sitting separately"; that is the whole claim.
 *
 * Signing a request rather than the URL alone is the other difference from
 * `seb.ts`. SEB hashes the URL, so a captured header is good for every
 * request to that URL; here the method, the body and a nonce are in the
 * signature, so a captured header is good for one request.
 */

/**
 * The wire format. Bumped only when the signed string below changes, which
 * is a breaking change for every installed copy — see `meetsVersionFloor`
 * for how a deployment stops accepting an old one.
 */
export const EXAM_BROWSER_PROTOCOL_VERSION = 1;

/** The custom scheme the readiness page uses to start the application. */
export const EXAM_BROWSER_SCHEME = "recx-exam";

/** Lower-case, as a `Headers` lookup returns them. */
export const RECX_PROTOCOL_HEADER = "x-recx-exam-protocol";
export const RECX_VERSION_HEADER = "x-recx-exam-version";
export const RECX_SITTING_HEADER = "x-recx-exam-sitting";
export const RECX_NONCE_HEADER = "x-recx-exam-nonce";
export const RECX_TIMESTAMP_HEADER = "x-recx-exam-timestamp";
export const RECX_SIGNATURE_HEADER = "x-recx-exam-signature";

/**
 * How far out of step a candidate's clock may be.
 *
 * Two minutes either way. A laptop that has not synchronised in a week can
 * be a minute out, and refusing a candidate at 9am over clock drift is a
 * far worse outcome than a two-minute window in which a captured signature
 * could be replayed — which the nonce closes anyway, and which requires
 * having captured one from inside the candidate's own machine to begin
 * with.
 */
export const EXAM_BROWSER_SKEW_TOLERANCE_MS = 120_000;

/**
 * Why a request was refused. A closed set: each one has a sentence a
 * candidate can act on and an audit action a reviewer can read.
 */
export const EXAM_BROWSER_REFUSALS = [
  /** No attestation headers at all: an ordinary browser at the exam URL. */
  "absent",
  /** A header is present but unparseable, or one of the set is missing. */
  "malformed",
  /** A wire format this deployment does not speak. */
  "protocol_unsupported",
  /** Older than the floor the deployment requires. */
  "version_below_floor",
  /** The timestamp is outside the tolerance in either direction. */
  "expired",
  /** No sitting key under that id: expired, ended, or never issued. */
  "unknown_sitting",
  /** The signature does not match what the key produces. */
  "mismatch",
] as const;
export type ExamBrowserRefusal = (typeof EXAM_BROWSER_REFUSALS)[number];

/**
 * What the candidate is told.
 *
 * Each sentence names the thing to do next, and none of them blames the
 * candidate for a setup problem: `unknown_sitting` and `expired` are
 * usually the product's fault or a clock's, and the candidate is sitting an
 * exam against a clock while reading it.
 */
export const EXAM_BROWSER_REFUSAL_MESSAGES: Readonly<Record<ExamBrowserRefusal, string>> = Object.freeze({
  absent:
    "This assessment must be sat in REC Exam Browser. Go back to the readiness check and choose Launch REC Exam Browser.",
  malformed:
    "REC Exam Browser could not be verified for this assessment. Close it and launch it again from the readiness check.",
  protocol_unsupported:
    "This copy of REC Exam Browser is too old for this assessment. Install the current version from the readiness check, then launch it again.",
  version_below_floor:
    "This copy of REC Exam Browser is out of date. Install the current version from the readiness check, then launch it again.",
  expired:
    "REC Exam Browser could not be verified, which is usually a clock that is out of step. Check the date and time on this machine, then launch it again from the readiness check. Tell your invigilator if it keeps happening.",
  unknown_sitting:
    "This sitting is no longer open in REC Exam Browser. Go back to the readiness check and launch it again.",
  mismatch:
    "REC Exam Browser could not be verified for this assessment. Close it and launch it again from the readiness check, and tell your invigilator if it happens twice.",
});

/** What the browser put on the request. Any of them may be absent. */
export interface ExamBrowserPresented {
  readonly protocol: string | null;
  readonly version: string | null;
  readonly sittingId: string | null;
  readonly nonce: string | null;
  readonly timestamp: string | null;
  readonly signature: string | null;
}

export type ExamBrowserVerdict =
  | {
      readonly ok: true;
      /** The sitting the signature proves, for the caller to bind its checks to. */
      readonly sittingId: string;
      /**
       * Record this against the sitting and refuse it next time. Returned
       * rather than checked here on purpose: see `verifyExamBrowser`.
       */
      readonly nonce: string;
      /** For the audit row and the invigilator's screen. Never the key. */
      readonly version: string;
    }
  | { readonly ok: false; readonly refusal: ExamBrowserRefusal; readonly message: string };

const refuse = (refusal: ExamBrowserRefusal): ExamBrowserVerdict => ({
  ok: false,
  refusal,
  message: EXAM_BROWSER_REFUSAL_MESSAGES[refusal],
});

/** Trimmed, lower-cased, and null when it is empty — a proxy may re-case a header. */
function normalise(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * The exact bytes both ends sign.
 *
 * Newline-joined with a leading tag, and every field is present even when
 * it is empty, so no two different requests can produce the same string by
 * one field absorbing another's content. The tag carries the protocol
 * version, so a signature made under one wire format can never verify under
 * the next.
 */
export function examBrowserSigningInput(args: {
  readonly method: string;
  readonly url: string;
  /** Hex digest of the request body, or null for a request without one. */
  readonly bodyHash: string | null;
  readonly nonce: string;
  readonly timestamp: number;
  readonly sittingId: string;
}): string {
  return [
    `${EXAM_BROWSER_SCHEME}/v${EXAM_BROWSER_PROTOCOL_VERSION}`,
    args.method.toUpperCase(),
    examBrowserUrlFor(args.url),
    args.bodyHash ?? "-",
    args.nonce,
    String(args.timestamp),
    args.sittingId,
  ].join("\n");
}

/**
 * The URL both ends sign: absolute, fragment dropped, query kept, and
 * normalised by `URL` itself — which lower-cases the host and drops a
 * default port, so two spellings of one address cannot disagree.
 *
 * `sebUrlFor` drops the query because SEB hashes a URL and a client-added
 * parameter would otherwise let the client choose the hash input. Here the
 * query is signed instead, because we write both ends and a signed query is
 * strictly better — a parameter cannot be altered in flight. A fragment is
 * dropped because it never reaches a server, so signing one would mean
 * signing something the verifier cannot see.
 */
export function examBrowserUrlFor(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Verify one request's attestation headers.
 *
 * `hmac` is injected, which keeps this module pure and lets a test drive it
 * with a known function rather than pre-computed fixtures.
 *
 * **The replay check is deliberately not done here**, and the order is the
 * reason. The nonce is only recorded once the signature has verified. If a
 * nonce were recorded before, anyone who can reach the exam URL — which is
 * anyone at all — could burn a nonce the real browser is about to use and
 * end a candidate's sitting from outside. So this returns the nonce in the
 * ok verdict, and the caller stores it then.
 */
export function verifyExamBrowser(args: {
  readonly method: string;
  readonly url: string;
  readonly bodyHash: string | null;
  readonly presented: ExamBrowserPresented;
  /** The key for the presented sitting, or null when there is no such sitting. */
  readonly sittingKey: string | null;
  /** The lowest application version this deployment accepts, or null for any. */
  readonly versionFloor: string | null;
  readonly now: number;
  readonly hmac: (key: string, message: string) => string;
}): ExamBrowserVerdict {
  const protocol = normalise(args.presented.protocol);
  const version = normalise(args.presented.version);
  const sittingId = normalise(args.presented.sittingId);
  const nonce = normalise(args.presented.nonce);
  const timestamp = normalise(args.presented.timestamp);
  const signature = normalise(args.presented.signature);

  // Nothing at all: an ordinary browser, which gets a different sentence
  // from a wrong signature because the thing to do about it is different.
  if (protocol === null && version === null && sittingId === null && signature === null) {
    return refuse("absent");
  }
  if (protocol === null || version === null || sittingId === null || nonce === null || timestamp === null || signature === null) {
    return refuse("malformed");
  }

  if (!/^\d+$/.test(protocol)) return refuse("malformed");
  if (Number(protocol) !== EXAM_BROWSER_PROTOCOL_VERSION) return refuse("protocol_unsupported");

  if (!parseVersion(version)) return refuse("malformed");
  if (args.versionFloor !== null && !meetsVersionFloor(version, args.versionFloor)) {
    return refuse("version_below_floor");
  }

  if (!/^-?\d+$/.test(timestamp)) return refuse("malformed");
  const sent = Number(timestamp);
  if (!Number.isFinite(sent)) return refuse("malformed");
  if (Math.abs(args.now - sent) > EXAM_BROWSER_SKEW_TOLERANCE_MS) return refuse("expired");

  // After the cheap checks, so an unknown sitting is not a way to measure
  // anything about the ones that exist.
  if (args.sittingKey === null || args.sittingKey === "") return refuse("unknown_sitting");

  const wanted = args.hmac(
    args.sittingKey,
    examBrowserSigningInput({
      method: args.method,
      url: args.url,
      bodyHash: args.bodyHash,
      nonce,
      timestamp: sent,
      sittingId,
    }),
  );
  if (wanted.trim().toLowerCase() !== signature.toLowerCase()) return refuse("mismatch");

  return { ok: true, sittingId, nonce, version };
}

/**
 * Versions, compared as three numbers.
 *
 * Deliberately not a semver library: the application's version is a number
 * we mint, a floor is a number an administrator types into a settings box,
 * and the only question ever asked of them is "is this one at least that
 * one". A pre-release suffix is accepted and ignored in the comparison, so
 * a build called `1.4.0-rc.2` counts as `1.4.0` — a release candidate that
 * went to a hall is the version it says it is.
 */
export function parseVersion(version: string): readonly [number, number, number] | null {
  const match = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+][0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** True when `version` is the same as or newer than `floor`. Unparseable is false. */
export function meetsVersionFloor(version: string, floor: string): boolean {
  const left = parseVersion(version);
  const right = parseVersion(floor);
  if (!left || !right) return false;
  for (let i = 0; i < 3; i += 1) {
    if (left[i]! > right[i]!) return true;
    if (left[i]! < right[i]!) return false;
  }
  return true;
}

/**
 * The launch token: opaque to this module, which only says what one looks
 * like. Minted by the server, single-use, short-lived, and never logged.
 */
export const EXAM_BROWSER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

/** `recx-exam://launch?origin=…&token=…` — what the readiness page opens. */
export function examBrowserLaunchUrl(args: { readonly origin: string; readonly token: string }): string {
  const params = new URLSearchParams({ origin: args.origin, token: args.token });
  return `${EXAM_BROWSER_SCHEME}://launch?${params.toString()}`;
}

export type LaunchParse =
  | { readonly ok: true; readonly origin: string; readonly token: string }
  | { readonly ok: false; readonly reason: "not_a_launch" | "bad_origin" | "bad_token" };

/**
 * Read a launch URL, and refuse an origin the build was not shipped to
 * talk to.
 *
 * This check is the reason the function exists. A custom scheme is
 * registered system-wide, so **any** web page the candidate visits can open
 * `recx-exam://launch?origin=…`. Without an allowlist baked into the build,
 * a page could start the college's exam browser pointed at a server the
 * page controls — a window with no address bar, wearing the college's
 * application, asking for a college password. The allowlist is the
 * difference between a kiosk browser and a phishing kit that the college
 * signed.
 *
 * Compared on the parsed origin rather than as text, so a trailing slash, a
 * mixed-case host or a default port cannot sneak past, and
 * `https://exam.college.edu.evil.test` does not match
 * `https://exam.college.edu`.
 */
export function parseExamBrowserLaunchUrl(url: string, allowedOrigins: readonly string[]): LaunchParse {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "not_a_launch" };
  }
  if (parsed.protocol !== `${EXAM_BROWSER_SCHEME}:` || parsed.host !== "launch") {
    return { ok: false, reason: "not_a_launch" };
  }

  const origin = parsed.searchParams.get("origin") ?? "";
  const token = parsed.searchParams.get("token") ?? "";

  let candidate: URL;
  try {
    candidate = new URL(origin);
  } catch {
    return { ok: false, reason: "bad_origin" };
  }
  const allowed = allowedOrigins.some((entry) => {
    try {
      return new URL(entry).origin === candidate.origin;
    } catch {
      return false;
    }
  });
  if (!allowed) return { ok: false, reason: "bad_origin" };
  if (!EXAM_BROWSER_TOKEN_PATTERN.test(token)) return { ok: false, reason: "bad_token" };

  return { ok: true, origin: candidate.origin, token };
}

/**
 * Command-line switches the application refuses to start with.
 *
 * The first attack on a kiosk browser is not a clever one: it is launching
 * the college's own binary from a shell with `--remote-debugging-port` and
 * then driving the exam from Chrome DevTools Protocol on another machine,
 * or with `--load-extension` pointed at the content script that lies about
 * focus (`PROCTORING.md` §2). Electron honours most Chromium switches, so
 * the binary has to refuse them itself.
 *
 * Matched on the switch name before `=`, so `--load-extension=/tmp/x` is
 * caught, and matched case-insensitively with both `-` and `--` accepted,
 * because Chromium accepts all of those spellings.
 */
export const EXAM_BROWSER_REFUSED_SWITCHES: readonly string[] = Object.freeze([
  "remote-debugging-port",
  "remote-debugging-pipe",
  "remote-allow-origins",
  "inspect",
  "inspect-brk",
  "inspect-port",
  "load-extension",
  "disable-extensions-except",
  "allow-running-insecure-content",
  "disable-web-security",
  "disable-site-isolation-trials",
  "ignore-certificate-errors",
  "host-rules",
  "host-resolver-rules",
  "proxy-server",
  "proxy-pac-url",
  "auto-open-devtools-for-tabs",
  "js-flags",
  "no-sandbox",
  "disable-gpu-sandbox",
  "user-data-dir",
]);

/** The refused switches present in an argv, in the order given. Empty is a clean launch. */
export function refusedSwitches(argv: readonly string[]): readonly string[] {
  const refused = new Set(EXAM_BROWSER_REFUSED_SWITCHES);
  const found: string[] = [];
  for (const raw of argv) {
    const match = /^--?([A-Za-z0-9-]+)(?:=|$)/.exec(raw.trim());
    if (!match) continue;
    const name = match[1]!.toLowerCase();
    if (refused.has(name) && !found.includes(name)) found.push(name);
  }
  return found;
}
