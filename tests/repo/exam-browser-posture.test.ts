import { describe, expect, it } from "vitest";
import { findFiles, readRepoFile } from "./support/repo";

/**
 * What REC Exam Browser may not do (Phase 14c).
 *
 * `docs/EXAM-BROWSER.md` §7 lists the fences this application needs that
 * no web page does, and this is them. It exists because an Electron main
 * process reaches further than anything else in this repository: it can
 * record the screen, hook the keyboard, install a service and read the
 * candidate's files, and `docs/PROCTORING.md` §5 forbids every one of
 * those by name.
 *
 * It is also the second of the three reasons the application lives in this
 * repository rather than its own (`docs/EXAM-BROWSER.md` §2). Across a
 * repository boundary this file could not exist.
 */

const APP = "apps/exam-browser/src";
const sources = () => findFiles({ under: [APP], extensions: [".ts"] });

/**
 * Comments stripped before anything is searched.
 *
 * Every rule below is about what the code DOES, and this file's own
 * subject matter means the forbidden names appear constantly in prose —
 * `sitting.ts` says "not Electron's safeStorage" precisely because it does
 * not use it. A fence that read that as a violation would push the next
 * author towards explaining less, which is the opposite of what it is for.
 */
export function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/**
 * The same idea for XML, and for the same reason. The entitlements file
 * lists what it does NOT ask for, which is the most useful thing it says
 * and exactly what a scan for those names would trip over.
 */
export function withoutXmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "");
}

const all = () => sources().map((rel) => ({ rel, text: withoutComments(readRepoFile(rel)) }));
const main = () => withoutComments(readRepoFile("apps/exam-browser/src/main.ts"));

describe("it finds the application (sanity)", () => {
  it("reads a main process that creates a window", () => {
    expect(sources().length).toBeGreaterThan(3);
    expect(main()).toMatch(/new BrowserWindow\(/);
  });
});

describe("the scanner itself", () => {
  it("removes comments and keeps code (self-test)", () => {
    const line = "// not safeStorage\nconst a = 1;";
    expect(withoutComments(line)).toContain("const a = 1;");
    expect(withoutComments(line)).not.toContain("safeStorage");
    const block = "/** uses desktopCapturer */\nconst b = 2;";
    expect(withoutComments(block)).not.toContain("desktopCapturer");
    expect(withoutComments(block)).toContain("const b = 2;");
    expect(withoutComments('const u = "https://x.test";')).toContain("https://x.test");
    expect(withoutComments("globalShortcut.register()")).toContain("globalShortcut");
    const plist = "<!-- not device.camera -->\n<key>com.apple.security.cs.allow-jit</key>";
    expect(withoutXmlComments(plist)).not.toContain("device.camera");
    expect(withoutXmlComments(plist)).toContain("allow-jit");
  });
});

describe("no persistence — the line between an exam browser and a desktop agent", () => {
  /**
   * `docs/PROCTORING.md` §5 forbids "desktop agents", and §5 now says what
   * that means: software that keeps running when no paper is being sat. An
   * application the candidate launches for one sitting and quits
   * afterwards is not one, and this is what keeps that true.
   */
  const FORBIDDEN: ReadonlyArray<[string, RegExp]> = [
    ["an autostart entry", /setLoginItemSettings/],
    ["a tray icon that outlives the window", /\bnew Tray\b|require\(['"]electron['"]\)\.Tray/],
    ["a Windows service", /node-windows|sc\.exe|New-Service/],
    ["a scheduled task", /schtasks|launchctl|systemctl|crontab/],
    ["a background updater", /autoUpdater|electron-updater/],
  ];

  it.each(FORBIDDEN)("does not install %s", (_what, pattern) => {
    expect(all().filter(({ text }) => pattern.test(text)).map(({ rel }) => rel)).toEqual([]);
  });

  it("quits when the window closes, on every platform", () => {
    /**
     * The usual Electron idiom keeps the application alive on macOS
     * (`if (process.platform !== "darwin") app.quit()`). Here that would
     * leave a browser running after the paper ended, which is the thing
     * §5 forbids. So: no platform check, and the key is forgotten too.
     */
    const text = main();
    const handler = text.slice(text.indexOf('app.on("window-all-closed"'));
    expect(handler).toMatch(/app\.quit\(\)/);
    expect(handler.slice(0, handler.indexOf("});"))).not.toMatch(/darwin/);
    expect(handler).toMatch(/releaseSitting\(\)/);
  });
});

describe("no capture, no recording, no biometrics (PROCTORING.md §5)", () => {
  const FORBIDDEN: ReadonlyArray<[string, RegExp]> = [
    ["screen capture", /desktopCapturer/],
    ["webcam or microphone capture", /getUserMedia/],
    ["display capture", /getDisplayMedia/],
    ["any recording", /\bMediaRecorder\b/],
    ["asking for media access", /askForMediaAccess/],
    ["speech capture", /SpeechRecognition/],
    ["peer-to-peer media", /RTCPeerConnection/],
  ];

  it.each(FORBIDDEN)("%s appears nowhere in the application", (_what, pattern) => {
    expect(all().filter(({ text }) => pattern.test(text)).map(({ rel }) => rel)).toEqual([]);
  });
});

describe("no global input hooks, and no reading the clipboard", () => {
  it("registers no system-wide shortcut and hooks no key", () => {
    /**
     * `globalShortcut` captures a key combination across the whole
     * desktop, which is both a way to break other applications and one
     * step from a keylogger. The accelerators this browser needs are the
     * ones on its own focused window.
     */
    for (const pattern of [/globalShortcut/, /iohook/, /node-global-key-listener/, /SetWindowsHookEx/]) {
      expect(all().filter(({ text }) => pattern.test(text)).map(({ rel }) => rel), String(pattern)).toEqual([]);
    }
  });

  it("clears the clipboard and never reads it", () => {
    /**
     * Clearing is not reading. §5 forbids clipboard CONTENT capture —
     * paste events and sizes only — so `clipboard.clear()` is allowed and
     * every reader is not.
     */
    expect(main()).toMatch(/clipboard\.clear\(\)/);
    for (const pattern of [/clipboard\.readText/, /clipboard\.readHTML/, /clipboard\.readImage/, /clipboard\.readRTF/]) {
      expect(all().filter(({ text }) => pattern.test(text)).map(({ rel }) => rel), String(pattern)).toEqual([]);
    }
  });
});

describe("the renderer's privileges", () => {
  /**
   * A `webPreferences` object is exactly the kind of thing somebody
   * relaxes to debug something and forgets, and every one of these is the
   * difference between a page that can show a paper and a page that can
   * read the candidate's disk.
   */
  const REQUIRED: ReadonlyArray<[string, RegExp]> = [
    ["its own world", /contextIsolation:\s*true/],
    ["no Node", /nodeIntegration:\s*false/],
    ["no Node in workers", /nodeIntegrationInWorker:\s*false/],
    ["an OS sandbox", /sandbox:\s*true/],
    ["the same-origin policy", /webSecurity:\s*true/],
    ["no mixed content", /allowRunningInsecureContent:\s*false/],
    ["no console", /devTools:\s*false/],
    ["no webview tag", /webviewTag:\s*false/],
  ];

  it.each(REQUIRED)("the window is created with %s", (_what, pattern) => {
    expect(main()).toMatch(pattern);
  });

  it("never turns any of them the other way", () => {
    for (const pattern of [
      /contextIsolation:\s*false/,
      /nodeIntegration:\s*true/,
      /sandbox:\s*false/,
      /webSecurity:\s*false/,
      /devTools:\s*true/,
      /allowRunningInsecureContent:\s*true/,
    ]) {
      expect(all().filter(({ text }) => pattern.test(text)).map(({ rel }) => rel), String(pattern)).toEqual([]);
    }
  });

  it("protects the window's contents from screen capture", () => {
    // Prevents capture; records nothing. §5 is untouched by it.
    expect(main()).toMatch(/setContentProtection\(true\)/);
  });
});

describe("one origin, and nothing else", () => {
  it("refuses navigation and redirects off it, and opens no second window", () => {
    const text = main();
    expect(text).toMatch(/"will-navigate"/);
    expect(text).toMatch(/"will-redirect"/);
    expect(text).toMatch(/setWindowOpenHandler\(\(\)\s*=>\s*\(\{\s*action:\s*"deny"\s*\}\)\)/);
  });

  it("denies every permission request, through both handlers", () => {
    const text = main();
    expect(text).toMatch(/setPermissionRequestHandler/);
    expect(text).toMatch(/setPermissionCheckHandler/);
  });

  it("never waves a certificate error through", () => {
    /**
     * `event.preventDefault()` plus `callback(true)` on `certificate-error`
     * is one line, and it turns a kiosk browser into a
     * man-in-the-middle's dream. The handler exists here only to say no
     * out loud.
     */
    const text = main();
    const handler = text.slice(text.indexOf('"certificate-error"'));
    expect(handler.slice(0, 400)).toMatch(/callback\(false\)/);
    expect(handler.slice(0, 400)).not.toMatch(/callback\(true\)/);
  });
});

describe("the command line is checked before Chromium is up", () => {
  it("refuses a forbidden switch before app.whenReady", () => {
    /**
     * Order is the whole point: by the time `whenReady` fires, a switch
     * such as `--remote-debugging-port` has already had its effect.
     */
    const text = main();
    const check = text.indexOf("startupDecision(process.argv)");
    const ready = text.indexOf("app.whenReady()");
    expect(check).toBeGreaterThan(-1);
    expect(ready).toBeGreaterThan(-1);
    expect(check).toBeLessThan(ready);
  });

  it("exits the process rather than only asking the app to quit", () => {
    // `app.quit()` alone lets Electron carry on initialising.
    expect(main()).toMatch(/app\.exit\(2\);[\s\S]{0,60}process\.exit\(2\)/);
  });
});

describe("it holds nothing it should not", () => {
  it("never depends on the database package", () => {
    const pkg = readRepoFile("apps/exam-browser/package.json");
    expect(pkg).not.toMatch(/@recx\/db/);
    expect(pkg).not.toMatch(/prisma/i);
  });

  it("imports the protocol alone, not the whole shared barrel", () => {
    /**
     * `@recx/shared` is one barrel over sixty modules, and importing it
     * whole put the aptitude taxonomy and the triage vocabulary into a
     * binary a candidate installs — 290 KB of bundle where 14 KB was
     * needed. Tree-shaking removed the marking functions but not the
     * string tables, and "mostly shaken out" is not a property to rely on
     * for what ships to a student's laptop.
     *
     * So the application imports `@recx/shared/exam-browser`, which is
     * the wire protocol and nothing else. The rule is here rather than in
     * a bundle-size budget because the reason is what is in the file, not
     * how big it is.
     */
    const offenders = sources()
      .map((rel) => ({ rel, text: readRepoFile(rel) }))
      .filter(({ text }) => /from "@recx\/shared"/.test(text))
      .map(({ rel }) => rel);
    expect(offenders, 'import from "@recx/shared/exam-browser"').toEqual([]);
    expect(readRepoFile("packages/shared/package.json")).toMatch(/"\.\/exam-browser":/);
  });

  it("writes no key to disk", () => {
    /**
     * `docs/EXAM-BROWSER.md` §4: the application leaves nothing behind,
     * which is easiest to keep true by never writing anything down. The
     * sitting key lives in a module variable and is forgotten on the way
     * out.
     */
    for (const pattern of [/safeStorage/, /localStorage/, /writeFileSync/, /app\.getPath\(['"]userData['"]\)/]) {
      expect(all().filter(({ text }) => pattern.test(text)).map(({ rel }) => rel), String(pattern)).toEqual([]);
    }
  });

  it("keeps the key out of the renderer", () => {
    /**
     * The preload is reachable by the page, and the page is the one place
     * a candidate can run their own JavaScript. It exposes facts, never
     * capabilities, and never the sitting.
     */
    const preload = withoutComments(readRepoFile("apps/exam-browser/src/preload.ts"));
    expect(preload).not.toMatch(/sittingKey|heldSitting|attestationHeaders/);
    expect(preload).toMatch(/contextBridge\.exposeInMainWorld/);
  });
});

describe("the session the window is signed in with (Phase 14g)", () => {
  /**
   * The application now holds a real session cookie for the candidate's
   * account, because launching it for the first time showed that a fresh
   * Chromium with no cookies gets a 307 to /login -- a password form inside
   * a window with no address bar, which `docs/EXAM-BROWSER.md` §5 says must
   * never be taught to anybody.
   *
   * That makes the cookie store a place a credential lives, and these are
   * the rules that stop it becoming a place one is LEFT.
   */

  it("runs the sitting in an in-memory session, so nothing is written to disk", () => {
    /**
     * In Electron a partition without the `persist:` prefix is in-memory:
     * cookies, cache and storage live in the process and die with it. With
     * the prefix, the session cookie would be written into the user data
     * directory and would still be there tomorrow, on a machine that may be
     * shared.
     */
    const policy = withoutComments(readRepoFile("apps/exam-browser/src/policy.ts"));
    expect(policy).toMatch(/export const EXAM_PARTITION = "(?!persist:)[^"]+"/);
    expect(main()).toMatch(/fromPartition\(EXAM_PARTITION/);
    expect(main()).toMatch(/partition: EXAM_PARTITION/);

    const offenders = all().filter(({ text }) => /persist:/.test(text)).map(({ rel }) => rel);
    expect(offenders, "no persistent partition anywhere in the application").toEqual([]);
  });

  it("never touches the default session, which is the one that persists", () => {
    /**
     * `session.defaultSession` writes to the user data directory. Every
     * handler and every cookie goes through the in-memory partition
     * instead, and one line reverting to the default would quietly undo the
     * rule above.
     */
    const offenders = all().filter(({ text }) => /defaultSession/.test(text)).map(({ rel }) => rel);
    expect(offenders, "use examSession(), not session.defaultSession").toEqual([]);
  });

  it("sets the cookie http-only, so the page cannot read it", () => {
    /**
     * The page inside this window is the one place a candidate can run
     * their own JavaScript. A session cookie it could read is a session it
     * could carry somewhere else.
     */
    const policy = withoutComments(readRepoFile("apps/exam-browser/src/policy.ts"));
    expect(policy).toMatch(/httpOnly: true/);
    expect(policy).not.toMatch(/httpOnly: false/);
  });

  it("decides Secure from the scheme rather than hardcoding it either way", () => {
    /**
     * Not `true`: Chromium refuses a Secure cookie on an http:// URL and
     * this repository's own development origin is http://localhost:3000, so
     * hardcoding true would break every developer. Not `false` either: a
     * release build talks to https, and a session cookie without Secure is
     * one that leaks over a downgrade. So it follows the origin, which was
     * already checked against this build's allowlist.
     */
    const policy = withoutComments(readRepoFile("apps/exam-browser/src/policy.ts"));
    expect(policy).toMatch(/secure: args\.origin\.startsWith\("https:\/\/"\)/);
  });

  it("never logs the session token, or anything else it holds", () => {
    const offenders = all()
      .flatMap(({ rel, text }) => (text.match(/console\.[a-z]+\([^)]*\)/g) ?? []).map((call) => ({ rel, call })))
      .filter(({ call }) => /sessionToken|sittingKey|\btoken\b/.test(call))
      .map(({ rel, call }) => `${rel}: ${call}`);
    expect(offenders, "a credential in a log file is a credential on disk").toEqual([]);
  });

  it("keeps the session out of the renderer as well as the key", () => {
    const preload = withoutComments(readRepoFile("apps/exam-browser/src/preload.ts"));
    expect(preload).not.toMatch(/sessionToken|sessionCookie|cookies/);
  });

  it("places the cookie before the window ever navigates", () => {
    /**
     * Order, not politeness. Loading the readiness page first means the
     * candidate sees the sign-in form for however long the cookie takes to
     * arrive, which is the outcome this slice exists to remove.
     */
    const text = main();
    const cookie = text.indexOf("placeSessionCookie(outcome.sitting)");
    const load = text.indexOf("mainWindow.loadURL");
    expect(cookie).toBeGreaterThan(-1);
    expect(load).toBeGreaterThan(-1);
    expect(cookie).toBeLessThan(load);
  });
});

describe("what a college actually installs (Phase 14f)", () => {
  /**
   * The packaging configuration is part of the posture, not a build
   * detail. An installer decides what lands on a candidate's machine, what
   * it registers with the operating system, and whether anything is left
   * running afterwards -- which is the line `docs/PROCTORING.md` §5 draws
   * between an exam browser and a desktop agent.
   */
  const builder = () => readRepoFile("apps/exam-browser/electron-builder.yml");
  const manifest = () => JSON.parse(readRepoFile("apps/exam-browser/package.json")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  it("registers the scheme the readiness page actually opens, and no other", () => {
    /**
     * An installer registering a different scheme than the application
     * parses would leave every Launch button pressing nothing -- and the
     * failure would appear on a morning when a hall full of candidates is
     * waiting, because nothing else exercises the association.
     */
    const shared = readRepoFile("packages/shared/src/exam-browser.ts");
    const scheme = /EXAM_BROWSER_SCHEME = "([^"]+)"/.exec(shared)?.[1];
    expect(scheme, "EXAM_BROWSER_SCHEME").toBeTruthy();

    const schemes = builder()
      .slice(builder().indexOf("protocols:"))
      .split("\n")
      .slice(0, 6)
      .filter((line) => /^\s+- \S/.test(line) && !/name:/.test(line))
      .map((line) => line.replace(/^\s+-\s*/, "").trim());
    expect(schemes).toEqual([scheme]);
  });

  it("ships no auto-updater and no update feed", () => {
    /**
     * `docs/EXAM-BROWSER.md` §4 forbids a background updater by name. The
     * posture scan above keeps `electron-updater` out of the source; this
     * keeps it out of the manifest and keeps electron-builder from writing
     * an update feed into the artifacts, which is the other half of the
     * same promise.
     */
    const pkg = manifest();
    const named = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(named).filter((name) => /updater/.test(name))).toEqual([]);
    expect(builder()).toMatch(/^publish: null$/m);
  });

  it("installs for one user, so no candidate needs an administrator", () => {
    /**
     * A candidate on their own laptop should not have to find somebody with
     * an admin password an hour before a paper, and nothing this
     * application does needs the machine.
     */
    expect(builder()).toMatch(/perMachine: false/);
  });

  it("puts nothing in the package but the application's own two files", () => {
    /**
     * The first build of this configuration shipped 4.3 MB of zod -- its
     * own test suite included -- because `@recx/shared` was a runtime
     * dependency and electron-builder ships those. tsup inlines the shared
     * module, so the application needs no node_modules at all, and a
     * dependency list is an easier thing to change by accident than an
     * import statement. Phase 14c shipped the same mistake one layer up.
     */
    const pkg = manifest();
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
    expect(builder()).toMatch(/- "!node_modules\/\*\*\/\*"/);
    // And nothing smuggled in beside the application: no helper binary, no
    // editable config file, no certificate store of our own.
    expect(builder()).toMatch(/extraResources: \[\]/);
    expect(builder()).toMatch(/extraFiles: \[\]/);
  });

  it("asks macOS for nothing it is forbidden to do", () => {
    /**
     * An entitlements file is the most legible statement a macOS
     * application makes about what it is capable of. This one should be
     * readable in ten seconds, and the camera should visibly not be in it.
     */
    const plist = withoutXmlComments(readRepoFile("apps/exam-browser/build/entitlements.mac.plist"));
    for (const forbidden of [
      "device.camera",
      "device.audio-input",
      "device.microphone",
      "personal-information",
      "files.user-selected",
      "screen-capture",
    ]) {
      expect(plist, forbidden).not.toContain(forbidden);
    }
    // The two Chromium cannot run without, and nothing else.
    expect((plist.match(/<key>/g) ?? []).length).toBe(2);
  });

  it("has an icon of its own, which is not decoration", () => {
    /**
     * `src/config.ts` explains that any web page can open
     * `recx-exam://launch`, and that the worst such a page can do is start
     * the real application. A candidate still has to be able to tell the
     * real window from a page pretending to be it, and an application
     * wearing the default Electron logo gives them nothing to recognise.
     */
    expect(findFiles({ under: ["apps/exam-browser/build"], extensions: [".png"] })).toContain(
      "apps/exam-browser/build/icon.png",
    );
  });
});

describe("the window a candidate cannot wander out of (Phase 14j)", () => {
  /**
   * How far this goes, and where it stops, is the thing to keep straight.
   * The window can hold the front of the screen, take the shortcuts that
   * leave it, and refuse to be minimised. It cannot make another
   * application unreachable: the operating system owns window switching
   * and the candidate owns the machine (`docs/EXAM-BROWSER.md` §6). These
   * fences hold the part that is ours.
   */

  it("opens as a kiosk, not merely fullscreen", () => {
    // They are different: fullscreen is a window state a candidate can
    // leave, kiosk asks the platform to take the usual ways out away.
    // Both, because kiosk is unimplemented on some Linux window managers.
    expect(main()).toMatch(/kiosk: true/);
    expect(main()).toMatch(/fullscreen: true/);
  });

  it("cannot be minimised or maximised out of the way", () => {
    for (const option of [/minimizable: false/, /maximizable: false/]) {
      expect(main(), String(option)).toMatch(option);
    }
  });

  /**
   * Phase 15d, and this fence replaces one that was WRONG.
   *
   * It used to require `resizable: false`, on the reasoning that a window
   * a candidate cannot drag smaller is a window they cannot uncover the
   * desktop behind. On Windows that option does something else as well:
   * it becomes a pair of size constraints pinned at the minimum, and the
   * fullscreen request is clamped by them. The exam window opened at
   * 1036x647 on a 1536x960 screen -- `WINDOW.minWidth` plus an invisible
   * resize border -- with the desktop visible all around a paper the
   * invigilator believed was sealed, while `isFullScreen()` and
   * `isKiosk()` both returned true.
   *
   * Measured rather than guessed: the same options object was built six
   * ways against a real Electron and the bounds read back. `resizable:
   * true` was the only difference between 1036x647 and 1536x960.
   *
   * So the fence now holds the opposite, with the reason attached, and
   * the protection that option was carrying moves to `holdFullScreen` --
   * which judges in PIXELS, because the flag was the thing that lied.
   */
  it("is not built with the option that silently un-fullscreens it", () => {
    expect(main(), "resizable: false clamps the fullscreen request on Windows").not.toMatch(/resizable: false/);
    expect(main()).toMatch(/resizable: true/);
  });

  it("holds the screen by measuring it, never by asking whether it is fullscreen", () => {
    const text = main();
    expect(text, "a pixel check, not a flag").toMatch(/coversDisplay\(/);
    expect(text).toMatch(/function holdFullScreen\(/);
    // Everything that can leave the window the wrong size re-asserts it.
    expect(text, "on show").toMatch(/ready-to-show[\s\S]{0,120}holdFullScreen/);
    expect(text, "on leaving fullscreen").toMatch(/leave-full-screen[\s\S]{0,160}holdFullScreen/);
    expect(text, "on a resize").toMatch(/window\.on\("resize"[\s\S]{0,60}holdFullScreen/);
    expect(text, "when the screen itself changes").toMatch(
      /display-metrics-changed[\s\S]{0,60}holdFullScreen/,
    );
  });

  it("holds the front of the screen, on every desktop", () => {
    expect(main()).toMatch(/setAlwaysOnTop\(true, "screen-saver"\)/);
    expect(main()).toMatch(/setVisibleOnAllWorkspaces\(true, \{ visibleOnFullScreen: true \}\)/);
  });

  it("puts itself back in front, and goes back to fullscreen, when something takes over", () => {
    expect(main()).toMatch(/window\.on\("blur"/);
    expect(main()).toMatch(/window\.on\("leave-full-screen"/);
  });

  it("takes the shortcuts through the window, never through a global hook", () => {
    /**
     * `before-input-event` fires only for keys Chromium is delivering to
     * our own focused window. A global hook would read the keyboard while
     * the application does not have focus, which is a keylogger whatever
     * it is called -- and `docs/PROCTORING.md` §5 forbids it by name. The
     * scan above keeps `globalShortcut` out; this says what replaced it.
     */
    expect(main()).toMatch(/before-input-event/);
    expect(main()).toMatch(/blockedChord\(/);
  });

  it("records nothing about the keys it swallows", () => {
    /**
     * The one way a shortcut blocker becomes the thing the charter
     * forbids. The handler drops the key; it must not write it anywhere.
     */
    const text = main();
    const start = text.indexOf("before-input-event");
    const handler = text.slice(start, start + 700);
    expect(handler).not.toMatch(/console\.|log\(|record|event\.sender\.send/);
  });

  it("has no context menu, whose entries are the same shortcuts with a mouse", () => {
    expect(main()).toMatch(/"context-menu"/);
  });

  it("asks before closing mid-paper, and still lets a candidate leave", () => {
    /**
     * Not a trap, and this is the fence that keeps it from becoming one.
     * Somebody has to be able to walk out of an exam; software that would
     * not let them is software no college should install. So the close
     * handler must offer a way through, and the cancelling answer is the
     * default so Enter keeps the paper open.
     */
    const text = main();
    const start = text.indexOf('window.on("close"');
    expect(start, 'a close guard exists').toBeGreaterThan(-1);
    const handler = text.slice(start, start + 1200);
    expect(handler).toMatch(/showMessageBoxSync/);
    expect(handler, "a way out of the dialog").toMatch(/window\.close\(\)/);
    expect(handler, "cancelling is the default").toMatch(/defaultId: 0/);
  });
});

describe("the development build cannot be mistaken for a release one (Phase 14k)", () => {
  /**
   * A development build accepts origins a release build refuses, so it is
   * a phishing kit if it ever looks like the real thing. The separation is
   * not a convention: it is four mechanical differences, and this is where
   * somebody removing one has to come and delete a test.
   */
  const tsup = () => withoutComments(readRepoFile("apps/exam-browser/tsup.config.ts"));
  const script = () => withoutComments(readRepoFile("apps/exam-browser/scripts/build-dev.mjs"));
  const config = () => withoutComments(readRepoFile("apps/exam-browser/src/config.ts"));

  it("builds a release unless a development build was asked for", () => {
    /**
     * The default is the whole fence. A bundler that produced a
     * development build when an environment variable happened to be set
     * would turn every CI runner with a stray variable into a publisher of
     * installers that trust a laptop.
     */
    const text = tsup();
    expect(text, "the channel is decided by an explicit equality, not truthiness").toMatch(
      /RECX_EXAM_BUILD_CHANNEL\s*===\s*"development"\s*\?\s*"development"\s*:\s*"release"/,
    );
    expect(text, "a release bakes no extra origins").toMatch(/channel === "development"\s*\?/);
    expect(text, "the constant is always defined, or the bundle throws on first use").toMatch(
      /define:\s*\{[\s\S]*__RECX_BUILD__/,
    );
  });

  it("reads the baked value defensively, failing towards the release list", () => {
    const text = config();
    expect(text, "a missing constant is a release").toMatch(/typeof __RECX_BUILD__ === "undefined"/);
    expect(text, "only an explicit development channel widens anything").toMatch(
      /channel !== "development"[\s\S]{0,80}return RELEASE_BUILD/,
    );
  });

  it("gives the development build its own id, name and filename", () => {
    const text = script();
    expect(text, "its own application id, so it installs beside a release build").toMatch(/-c\.appId=\S+\.dev/);
    expect(text, "its own name in the Start menu and the uninstall list").toMatch(
      /-c\.productName=REC Exam Browser \(development\)/,
    );
    expect(text, "its own filename on disk").toMatch(/-c\.artifactName=[^\n]*-dev-/);
  });

  it("says what it is before the window opens, every launch", () => {
    const text = main();
    expect(text).toMatch(/buildIdentity\(\)\.channel === "development"/);
    expect(text, "a dialog, not a log line").toMatch(
      /channel === "development"[\s\S]{0,400}dialog\.showMessageBox/,
    );
    expect(config(), "and it says not to sit an exam with it").toMatch(/not for sitting a real exam/i);
  });

  it("is never published: nothing in the deployment reaches for a development artifact", () => {
    /**
     * `deploy/exam-browser/README.md` publishes what CI built. A
     * development installer carries `-dev-` in its filename, and nothing
     * under deploy/ should ever name one.
     */
    for (const rel of findFiles({ under: ["deploy/exam-browser"], extensions: [".md", ".yml", ".json", ".example"] })) {
      expect(readRepoFile(rel), rel).not.toMatch(/REC-Exam-Browser-[^\s"']*-dev-/);
    }
  });
});


describe("what the installer is allowed to carry (Phase 15a)", () => {
  /**
   * `packages/shared/src/exam-browser.ts` is compiled into the Electron
   * main process by tsup, so every import it grows is something a
   * candidate is asked to install on their own laptop to sit an exam.
   *
   * This is not hypothetical. The first packaged build put 4.3 MB inside
   * the installer -- the whole of zod, its own test suite included --
   * because `@recx/shared` was listed as a runtime dependency, and
   * `docs/EXAM-BROWSER.md` section 8 records it. The dependency list was
   * fixed; nothing stopped the next person adding `import { z }` to the
   * one shared file the browser actually imports, which would put it back
   * with no package.json change to notice in review.
   *
   * The zod schema that validates the signal payload therefore lives in
   * the web app, which is the only side that parses anything it did not
   * write.
   */
  it("the protocol module the browser imports has no imports of its own", () => {
    const text = withoutComments(readRepoFile("packages/shared/src/exam-browser.ts"));
    const imports = [...text.matchAll(/^\s*import\s[\s\S]*?from\s*"([^"]+)"/gm)].map((m) => m[1]);
    expect(imports, "keep this file dependency-free; see the comment in this test").toEqual([]);
    expect(text).not.toMatch(/\brequire\s*\(/);
  });

  it("and the bundle it produces carries no validator library", () => {
    /**
     * The fence above is about the source; this is about what the source
     * is allowed to mean. A transitive import is as expensive as a direct
     * one, and `signals.ts` is the newest file to import from it.
     */
    const browser = withoutComments(readRepoFile("apps/exam-browser/src/signals.ts"));
    const imports = [...browser.matchAll(/^\s*import\s[\s\S]*?from\s*"([^"]+)"/gm)].map((m) => m[1] ?? "");
    for (const specifier of imports) {
      expect(specifier.startsWith("@recx/shared") || specifier.startsWith("."), specifier).toBe(true);
    }
  });
});

describe("what the browser reports about the window (Phase 15a)", () => {
  const signals = () => withoutComments(readRepoFile("apps/exam-browser/src/signals.ts"));

  it("reports a count of screens, never anything on them", () => {
    /**
     * The distance between "how many screens" and "what is on them" is
     * the distance between this product and the one `PROCTORING.md`
     * section 5 refuses to be. A fence, because a plausible-sounding
     * improvement is how that line gets crossed.
     */
    const text = signals() + main();
    for (const forbidden of [/capturePage/, /desktopCapturer/, /getSources/, /thumbnail/i, /screenshot/i]) {
      expect(text, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it("records nothing about which application took the focus", () => {
    // A window title or an owning process is a record of what else the
    // candidate was doing, which is not this application's business and
    // is not what a focus signal is for.
    for (const forbidden of [/getWindowTitle/, /activeWindow/i, /foregroundWindow/i, /processName/i]) {
      expect(signals() + main(), String(forbidden)).not.toMatch(forbidden);
    }
  });

  it("sends the signals signed, to the exam origin's fixed path", () => {
    const text = main();
    expect(text, "signed by this process, not by the page").toMatch(
      /attestationHeaders\(\{\s*method: "POST"/,
    );
    expect(text, "no cookie is sent: the signature is the credential").toMatch(/credentials: "omit"/);
    expect(signals()).toMatch(/EXAM_BROWSER_SIGNALS_PATH/);
  });

  it("holds a batch that failed rather than dropping it", () => {
    // A signal lost to a flaky network is a line missing from a
    // reviewer's timeline, and the reviewer has no way to know it is
    // missing.
    expect(signals()).toMatch(/unshift\(\.\.\.batch\)/);
  });
});
/**
 * The one wildcard the allowlist understands, kept where it belongs
 * (Phase 15c).
 *
 * `http://localhost:*` exists because the operating system launches the
 * registered scheme handler with none of the shell environment that
 * `RECX_EXAM_DEV_ORIGIN` lives in, so an unpackaged run had no way to
 * name the dev server it was started for. Loopback needs no environment.
 *
 * It is also the only soft edge in a file whose entire job is to be hard,
 * so these hold the shape of it rather than trusting a comment: the
 * release list is exact origins, the wildcards are reachable only from
 * the unpackaged branch, and every one of them is loopback.
 */
describe("the loopback wildcard stays on the development side", () => {
  const policy = () => withoutComments(readRepoFile("apps/exam-browser/src/policy.ts"));
  const config = () => withoutComments(readRepoFile("apps/exam-browser/src/config.ts"));

  it("keeps every wildcard out of the release origins", () => {
    const list = config().slice(config().indexOf("RELEASE_ORIGINS"));
    const end = list.indexOf("]);");
    expect(end, "RELEASE_ORIGINS should be a closed literal").toBeGreaterThan(0);
    expect(list.slice(0, end)).not.toContain("*");
  });

  it("declares only loopback hosts as wildcards", () => {
    const text = policy();
    const start = text.indexOf("LOOPBACK_DEV_ORIGINS");
    const entries = text.slice(start, text.indexOf("]);", start)).match(/"[^"]+"/g) ?? [];
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const origin = entry.slice(1, -1);
      expect(origin, entry).toMatch(/^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\*$/);
    }
  });

  it("adds them on the unpackaged branch only", () => {
    // `args.packaged ? … : […LOOPBACK_DEV_ORIGINS]`: the constant must not
    // appear anywhere a packaged build can reach.
    const text = policy();
    const fn = text.slice(text.indexOf("export function allowedOrigins"));
    const opened = fn.indexOf("): readonly string[] {");
    const body = fn.slice(opened, fn.indexOf("\n}", opened));
    const packagedBranch = body.slice(body.indexOf("args.packaged"), body.indexOf(":", body.indexOf("build.origins")));
    expect(packagedBranch).not.toContain("LOOPBACK_DEV_ORIGINS");
    expect(body).toContain("LOOPBACK_DEV_ORIGINS");
  });
});
