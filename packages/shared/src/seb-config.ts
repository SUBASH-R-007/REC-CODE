/**
 * The .seb file a candidate opens to sit a kiosk paper (Phase 12y.8).
 *
 * Safe Exam Browser reads its settings from a `.seb` configuration: an
 * Apple property list naming the URL to open and how the browser should
 * behave while it is open. Until now this product verified SEB's headers
 * (Phase 6d) and left producing that file to the department — so a paper
 * set to KIOSK_SEB refused every candidate with *"open the exam from the
 * .seb file your department gave you"* and there was no such file.
 *
 * It is generated rather than uploaded because the one thing it must get
 * right is the start URL, and that is ours to know. A file hand-made in
 * the Config Tool and pointed at a mistyped host is a room of candidates
 * who cannot start.
 *
 * **What this file is not.** It is a configuration, not a lock. SEB's own
 * guarantees are what they are: on a machine where SEB is not installed
 * the link does nothing, a candidate can quit SEB, and nothing here
 * prevents a second device. `docs/PROCTORING.md` §2 says so plainly, and
 * the verification that makes the mode mean anything is the key check on
 * every request, not this file.
 *
 * **The Config Key.** SEB derives one from the settings and sends
 * `sha256(url + configKey)` on every request; the server compares it
 * against the key an administrator configured. This module does NOT
 * compute that key: SEB's derivation has its own canonical-JSON rules, and
 * a key computed here and wrong would refuse every candidate in the hall
 * with no way to tell why. The key stays something an administrator reads
 * out of SEB Config Tool for this exact file and saves — one step, once
 * per paper, with the file in front of them.
 */

export interface SebConfigOptions {
  /** Where SEB opens: the readiness page, never the sitting itself. */
  readonly startUrl: string;
  /** Where "quit" returns to, so a candidate who finishes can leave cleanly. */
  readonly quitUrl: string;
  /** The origin SEB is allowed to load at all; everything else is refused. */
  readonly allowedOrigin: string;
}

/**
 * XML text escaping.
 *
 * The values here are URLs, and a URL can carry an `&`. The first draft of
 * this module also took a `title` and never wrote it anywhere — a
 * parameter every caller filled in and nothing read, which the test for
 * escaping is what found. There is no SEB setting for a paper's name that
 * this file could honestly set, so there is no parameter for one either.
 */
function xml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const str = (key: string, value: string) => `  <key>${xml(key)}</key>\n  <string>${xml(value)}</string>`;
const bool = (key: string, value: boolean) => `  <key>${xml(key)}</key>\n  <${value ? "true" : "false"}/>`;
const int = (key: string, value: number) => `  <key>${xml(key)}</key>\n  <integer>${Math.trunc(value)}</integer>`;

/**
 * Build the configuration, as plain (unencrypted) XML.
 *
 * Unencrypted on purpose: an encrypted .seb hides its settings from the
 * candidate, and the settings here are not a secret — they are a start URL
 * and a short list of behaviours. What a password would protect is the
 * file against tampering, and the Config Key already does that: a file
 * edited by a candidate produces a different key and the server refuses
 * every request made with it.
 *
 * Every setting below is a decision, so every setting has a reason:
 */
export function buildSebConfig(options: SebConfigOptions): string {
  const lines = [
    str("startURL", options.startUrl),
    // SEB sends the two headers this product verifies. Without this the
    // whole kiosk mode is decoration: the server would have nothing to
    // check and would refuse every request as `absent`.
    bool("sendBrowserExamKey", true),
    bool("examSessionClearCookiesOnStart", true),
    // Quitting is allowed and goes somewhere sensible. A kiosk browser a
    // candidate cannot leave after handing in is a candidate sitting in
    // front of a locked screen asking for help.
    bool("allowQuit", true),
    str("quitURL", options.quitUrl),
    bool("quitURLConfirm", true),
    // One window, no second tab to wander into, no address bar to type
    // another site into. This is the part of kiosk mode that genuinely
    // helps: it removes the easy drift, not the determined cheat.
    int("browserViewMode", 1),
    bool("allowBrowsingBackForward", false),
    bool("newBrowserWindowByLinkPolicy", false),
    bool("newBrowserWindowByScriptPolicy", false),
    bool("enableBrowserWindowToolbar", false),
    bool("showMenuBar", false),
    bool("showTaskBar", true),
    bool("allowSpellCheck", false),
    bool("allowPreferencesWindow", false),
    // Reloading is allowed: a sitting is resumable by design, and a
    // candidate whose page breaks must be able to get it back.
    bool("browserWindowAllowReload", true),
    bool("showReloadButton", true),
    // Nothing but this college's own site loads at all.
    bool("URLFilterEnable", true),
    bool("URLFilterEnableContentFilter", true),
    bool("allowDownUploads", false),
    // A virtual machine is the standard way to run a "kiosk" browser and a
    // second, unwatched desktop beside it.
    bool("allowVirtualMachine", false),
    bool("enableLogging", false),
    str("originatorVersion", "REC Code"),
  ];

  const filter = [
    "  <key>URLFilterRules</key>",
    "  <array>",
    "    <dict>",
    "      <key>action</key><integer>1</integer>",
    "      <key>active</key><true/>",
    `      <key>expression</key><string>${xml(`${options.allowedOrigin}/*`)}</string>`,
    "      <key>regex</key><false/>",
    "    </dict>",
    "  </array>",
  ];

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    ...lines,
    ...filter,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/**
 * The link that hands the configuration straight to SEB.
 *
 * SEB registers the `seb:` and `sebs:` schemes: given `seb://host/path`, it
 * fetches that URL over http (and `sebs://` over https), reads the
 * configuration and opens the exam. That is what turns "download this
 * file, find it, open it with the right application" into one click — and
 * on a machine with no SEB the link simply does nothing, which is why the
 * page offers the plain download beside it.
 */
export function sebLaunchUrl(configUrl: string): string {
  const url = new URL(configUrl);
  const scheme = url.protocol === "https:" ? "sebs:" : "seb:";
  return `${scheme}//${url.host}${url.pathname}${url.search}`;
}
