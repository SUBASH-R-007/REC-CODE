import { fileURLToPath } from "node:url";
import path from "node:path";
import { BrowserWindow, app, clipboard, dialog, ipcMain, screen, session } from "electron";
import { EXAM_BROWSER_SCHEME } from "@recx/shared/exam-browser";
import { APP_VERSION, DEVELOPMENT_BUILD_WARNING, WINDOW, buildIdentity, readinessPath } from "./config";
import { LAUNCH_FAILURE_MESSAGES, exchange, launchUrlIn } from "./launch";
import {
  EXAM_PARTITION,
  allowedOrigins,
  blockedChord,
  coversDisplay,
  displayReport,
  navigationDecision,
  permissionDecision,
  sessionCookieFor,
  shouldAttest,
  startupDecision,
} from "./policy";
import { attestationHeaders, heldSitting, holdSitting, releaseSitting, type Sitting } from "./sitting";
import { SignalQueue } from "./signals";

/**
 * REC Exam Browser — the main process (Phase 14c).
 *
 * Wiring, and as little judgement as possible: every decision is a call
 * into `policy.ts`, which is plain functions over plain values and is
 * where the tests are. `docs/EXAM-BROWSER.md` is what this is and what it
 * is worth; §7 is the list of things it must not do, and
 * `tests/repo/exam-browser-posture.test.ts` reads this file to check it
 * does not do them.
 *
 * The shape of a sitting:
 *
 *   1. The operating system hands us `recx-exam://launch?origin=…&token=…`.
 *   2. The origin is checked against this build's own list before anything
 *      is sent anywhere, then the token is exchanged for a sitting key and
 *      a session.
 *   3. The session is placed as a cookie BEFORE the first navigation, and a
 *      window opens on the readiness page of that origin and can reach
 *      nothing else.
 *   4. Every request to that origin carries an attestation header set.
 *   5. The paper ends, the key is forgotten, the application quits. It
 *      installs nothing, registers no service and leaves nothing running.
 */

const DIRNAME = path.dirname(fileURLToPath(import.meta.url));

/**
 * BEFORE anything else, including `app.whenReady()`: by the time Chromium
 * is up, a switch has already had its effect. `app.quit()` here is not
 * enough either — the first draft called it and Electron carried on
 * initialising — so this exits the process.
 */
const startup = startupDecision(process.argv);
if (!startup.ok) {
  process.stderr.write(
    `REC Exam Browser will not start with these command-line switches: ${startup.switches.join(", ")}.\n` +
      "Launch it from the readiness check in REC Code.\n",
  );
  app.exit(2);
  process.exit(2);
}

/**
 * One copy, one sitting. A second launch does not open a second window —
 * it hands its URL to the copy already running, which is what should
 * happen when a candidate presses Launch twice. Without this, the second
 * copy would try to spend an already-spent token and the candidate would
 * read an alarming sentence about two applications holding one key.
 */
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
  process.exit(0);
}

/**
 * Own the scheme the readiness page opens.
 *
 * A packaged build is its own executable and needs no more than the name.
 * An unpackaged run is `electron dist/main.js`, where registering the
 * executable alone would point the scheme at a bare Electron with no
 * application to run -- so the script goes in too. Without this, pressing
 * Launch on a development server wakes whatever packaged copy is
 * installed, which then refuses the localhost origin and shows the
 * candidate dialog, and the developer concludes the origin list is broken
 * when it is doing its job.
 */
if (app.isPackaged) {
  app.setAsDefaultProtocolClient(EXAM_BROWSER_SCHEME);
} else {
  app.setAsDefaultProtocolClient(EXAM_BROWSER_SCHEME, process.execPath, [path.resolve(process.argv[1] ?? "")]);
}

/**
 * The session every request in this application goes through.
 *
 * `fromPartition` with no `persist:` prefix is an in-memory session
 * (`policy.ts`'s `EXAM_PARTITION` says why that matters), and it is used
 * instead of `session.defaultSession` everywhere: the default session writes
 * cookies and cache into the user data directory, and from Phase 14g the
 * cookie in question is a live session on the candidate's account.
 */
const examSession = () => session.fromPartition(EXAM_PARTITION, { cache: false });

let mainWindow: BrowserWindow | null = null;
/** Set once the candidate has confirmed they are leaving, so the close guard stands aside. */
let closing = false;

/**
 * What this window saw, on its way to the server (Phase 15a).
 *
 * The page reports its own focus, its own fullscreen state and its own
 * monitor count, and `docs/PROCTORING.md` section 2 says all three are
 * falsifiable -- the exam page is the one place a candidate can run their
 * own JavaScript. This process signs with a key the page never sees, so
 * what it says can be neither forged nor silenced by a script in the
 * window. Same vocabulary, different witness; `signals.ts` holds the
 * queue and says what it refuses to record.
 */
const signals = new SignalQueue({
  startedAtMs: Date.now(),
  now: () => Date.now(),
  origin: () => heldSitting()?.origin ?? null,
  onError: (name) => console.error("[exam-browser] could not report what the window saw:", name),
  sink: {
    post: async (url, body) => {
      const sitting = heldSitting();
      if (!sitting) return false;
      /**
       * Signed here rather than through `onBeforeSendHeaders`, which only
       * sees requests made by the renderer's session. This one is the
       * main process speaking for itself, which is the whole point of it.
       */
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...attestationHeaders({ method: "POST", url, sitting }),
        },
        body,
        // No cookies in either direction: the signature is the credential.
        credentials: "omit",
        redirect: "error",
      });
      return response.ok;
    },
  },
});
/** Set once, by the first launch URL we successfully exchange. */
let origins: readonly string[] = [];

function originsForThisBuild(): readonly string[] {
  if (origins.length === 0) {
    origins = allowedOrigins({ packaged: app.isPackaged, build: buildIdentity(), environment: process.env });
  }
  return origins;
}

/**
 * The window every candidate sits in.
 *
 * Each option here is load-bearing and the comments say which rule it
 * serves, because a `webPreferences` object is exactly the kind of thing
 * somebody relaxes while debugging and forgets.
 */
/**
 * Keep the window over the whole screen, judged in pixels (Phase 15d).
 *
 * `isFullScreen()` is not consulted, deliberately: it returned true for a
 * window covering less than half the screen, which is the bug this
 * function exists for. What it asks instead is whether the window's
 * bounds cover the bounds of the display it is on (`coversDisplay` in
 * `policy.ts`), and if they do not it says so again -- fullscreen first,
 * then the display's own bounds, because a window whose fullscreen flag
 * is already set will not act on being told a second time.
 *
 * Re-entrancy: `setBounds` fires `resize`, which calls this again. The
 * second call finds the window covering the display and does nothing, so
 * it settles in one step rather than looping.
 */
function holdFullScreen(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  const display = screen.getDisplayMatching(window.getBounds());
  if (coversDisplay(window.getBounds(), display.bounds)) return;
  if (!window.isFullScreen()) window.setFullScreen(true);
  if (!coversDisplay(window.getBounds(), display.bounds)) window.setBounds(display.bounds);
}

function createWindow(origin: string): BrowserWindow {
  const window = new BrowserWindow({
    show: false,
    fullscreen: true,
    // Kiosk as well as fullscreen (Phase 14j). They are not the same
    // thing: fullscreen is a window state a candidate can leave, kiosk
    // asks the platform to keep the window in front and take the usual
    // ways out away. Both, because kiosk is unimplemented on some Linux
    // window managers and fullscreen is what is left there.
    kiosk: true,
    frame: false,
    autoHideMenuBar: true,
    // No minimise and no restore-down, so the paper cannot be put aside.
    minimizable: false,
    maximizable: false,
    /**
     * Resizable, and that is NOT a relaxation (Phase 15d).
     *
     * `resizable: false` was here to stop a candidate dragging the window
     * smaller to uncover what is behind it. On Windows it does something
     * else as well: it becomes a pair of size constraints pinned at the
     * minimum, and a fullscreen request is then CLAMPED BY THEM. The
     * window opened at 1036x647 on a 1536x960 screen -- the desktop and
     * everything on it visible around a paper the invigilator believed
     * was sealed -- while `isFullScreen()` and `isKiosk()` both returned
     * true. Measured, in `scripts/` terms, by building this exact options
     * object six ways and reading the bounds back.
     *
     * Nothing is lost. The window is frameless, fullscreen and always on
     * top, so there is no edge exposed to drag; `holdFullScreen` below
     * puts back anything that does get out, and it checks the PIXELS
     * rather than asking the component that was wrong.
     */
    resizable: true,
    fullscreenable: true,
    backgroundColor: WINDOW.backgroundColor,
    minWidth: WINDOW.minWidth,
    minHeight: WINDOW.minHeight,
    webPreferences: {
      preload: path.join(DIRNAME, "preload.js"),
      // The in-memory session, so nothing this sitting touches is written
      // to disk -- the session cookie above all.
      partition: EXAM_PARTITION,
      // The renderer gets no Node, its own world, and an OS sandbox.
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      // There is no console to open, and no shortcut that opens one.
      devTools: false,
      // A page cannot ask for a window it could then navigate anywhere.
      webviewTag: false,
      spellcheck: false,
    },
  });

  /**
   * Blank in most screen captures and screen shares on Windows and macOS.
   * This PREVENTS capture; it records nothing about the candidate, so
   * `docs/PROCTORING.md` §5 is untouched by it.
   */
  window.setContentProtection(true);
  window.setMenuBarVisibility(false);

  /**
   * Above everything, on every desktop (Phase 14j).
   *
   * "screen-saver" is the highest level Electron offers, which is what
   * keeps a notification toast or another application's window from
   * landing on top of a paper. `setVisibleOnAllWorkspaces` stops a
   * candidate moving to another virtual desktop and leaving the window
   * behind on the first one.
   *
   * None of this makes another application unreachable, and §6 of
   * `docs/EXAM-BROWSER.md` says so plainly: the operating system owns
   * window switching and a candidate owns the machine. What it does is
   * make leaving deliberate and visible rather than accidental.
   */
  window.setAlwaysOnTop(true, "screen-saver");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  /**
   * Keys the window swallows. `policy.ts` holds the list and the
   * reasoning; this is window-scoped, so nothing is seen while another
   * application has focus and nothing is written down either way.
   */
  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (
      blockedChord({
        key: input.key,
        control: input.control,
        meta: input.meta,
        alt: input.alt,
        shift: input.shift,
      })
    ) {
      event.preventDefault();
    }
  });

  /**
   * No context menu. Its entries are the shortcuts above with a mouse:
   * open in a new window, save as, view source, inspect.
   */
  window.webContents.on("context-menu", (event) => event.preventDefault());

  /**
   * Put back in front when something takes focus (Phase 14j).
   *
   * Once per event, never in a loop: a window that fights the operating
   * system for focus is a window a candidate cannot escape to answer the
   * door, and `docs/PROCTORING.md` §3 is clear that nothing here gets to
   * act against a person. The exam page already records focus loss as a
   * proctor event through its own listener, so this is the deterrent half
   * -- alt-tabbing away does not leave the paper sitting quietly behind
   * somebody else's window.
   */
  window.on("blur", () => {
    // Recorded before the window is put back, so the duration is how long
    // the candidate was actually away rather than how long we took.
    signals.focusLost();
    if (window.isDestroyed()) return;
    window.showInactive();
    window.setAlwaysOnTop(true, "screen-saver");
  });
  window.on("focus", () => signals.focusRestored());
  window.on("leave-full-screen", () => {
    signals.note("FULLSCREEN_EXIT");
    holdFullScreen(window);
  });

  /**
   * Re-checked whenever the screen itself changes (Phase 15d). A monitor
   * unplugged mid-paper, a resolution change, a dock disconnected: each
   * leaves a window sized for a screen that is no longer there.
   */
  screen.on("display-metrics-changed", () => holdFullScreen(window));
  window.on("resize", () => holdFullScreen(window));

  // Nothing opens a second window. Not target=_blank, not window.open.
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  const refuse = (event: { preventDefault: () => void }, url: string) => {
    if (navigationDecision(url, origin).allow) return;
    event.preventDefault();
    console.warn("[exam-browser] refused navigation off the exam origin");
  };
  window.webContents.on("will-navigate", (event, url) => refuse(event, url));
  window.webContents.on("will-redirect", (event, url) => refuse(event, url));

  /**
   * A certificate error on the exam origin is never waved through. The
   * default is already to refuse; this makes it explicit, because
   * `event.preventDefault()` plus `callback(true)` is the one line that
   * would turn this application into a man-in-the-middle's dream.
   */
  window.webContents.on("certificate-error", (event, _url, _error, _certificate, callback) => {
    callback(false);
  });

  /**
   * Closing the window mid-paper asks first (Phase 14j).
   *
   * Not a trap. A candidate must always be able to leave -- somebody has
   * to be able to walk out of an exam, and software that would not let
   * them is software no college should install. What this prevents is the
   * accident: Alt+F4 or a stray click ending a sitting that the candidate
   * meant to hand in from inside the paper.
   *
   * The dialog is modal to this window and has the cancelling answer as
   * its default, so Enter keeps the paper open.
   */
  window.on("close", (event) => {
    if (!heldSitting() || closing) return;
    event.preventDefault();
    const choice = dialog.showMessageBoxSync(window, {
      type: "question",
      title: "REC Exam Browser",
      message: "Leave the exam?",
      detail:
        "Your paper is still open. Hand it in from inside the paper to submit your answers. Closing this window now does not submit anything.",
      buttons: ["Keep sitting", "Close without submitting"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (choice === 1) {
      closing = true;
      window.close();
    }
  });

  window.once("ready-to-show", () => {
    window.show();
    holdFullScreen(window);
  });
  window.on("closed", () => {
    mainWindow = null;
  });
  return window;
}

/**
 * Attach the attestation to every request going to the exam origin, and to
 * nothing else.
 *
 * In `onBeforeSendHeaders` rather than in page code: the page cannot be
 * asked to sign, because the key must not be in the renderer, and this way
 * every request the page makes — fetch, XHR, navigation, the editor's own
 * chunk loads — is signed without the page knowing anything about it.
 */
function attachAttestation(): void {
  const sittingSession = examSession();
  sittingSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const sitting = heldSitting();
    if (!sitting || !shouldAttest(details.url, sitting.origin)) {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }
    callback({
      requestHeaders: {
        ...details.requestHeaders,
        ...attestationHeaders({ method: details.method, url: details.url, sitting }),
      },
    });
  });

  // Nothing gets a permission. Both handlers, because Chromium asks
  // through one or the other depending on the API.
  sittingSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permissionDecision(permission));
  });
  sittingSession.setPermissionCheckHandler((_contents, permission) => permissionDecision(permission));
}

/**
 * Open a sitting from a launch URL.
 *
 * Failures are shown as a dialog rather than written to a console nobody
 * can open. `bad_origin` gets its own sentence telling the candidate NOT
 * to type their password, because that is the case where something has
 * tried to point the college's own application at somebody else's server.
 */
async function openSitting(launchUrl: string): Promise<void> {
  const outcome = await exchange({ launchUrl, allowedOrigins: originsForThisBuild() });
  if (!outcome.ok) {
    const message =
      LAUNCH_FAILURE_MESSAGES[outcome.reason] ??
      "This sitting could not be started. Go back to the readiness check and launch it again.";
    await dialog.showMessageBox({ type: "warning", title: "REC Exam Browser", message, buttons: ["Close"] });
    app.quit();
    return;
  }

  holdSitting(outcome.sitting);

  /**
   * The clipboard is cleared on the way in and on the way out. Clearing is
   * not reading: nothing here ever asks what was in it, which
   * `docs/PROCTORING.md` §5 forbids by name. And §2 is honest about what
   * this is worth — a tool that types the clipboard as synthetic
   * keystrokes walks straight past it, so this is deterrence and a
   * cleaner signal, not a control.
   */
  clipboard.clear();

  /**
   * Before the window, and before any navigation (Phase 14g).
   *
   * Launching the real application for the first time is what found this:
   * every exam page requires a signed-in user, this is a fresh Chromium
   * with no cookies, and the readiness page answered with a 307 to /login
   * -- a password form inside a frame with no address bar, which is exactly
   * the habit `docs/EXAM-BROWSER.md` §5 says must never be taught. No unit
   * test could have seen it, because none of them navigate.
   *
   * A failure here is fatal rather than logged: carrying on would load the
   * sign-in form, which is the one outcome this must not produce.
   */
  if (!(await placeSessionCookie(outcome.sitting))) {
    await dialog.showMessageBox({
      type: "warning",
      title: "REC Exam Browser",
      message:
        "This sitting could not be opened on this machine. Close this window and launch it again from the readiness check. If it happens twice, tell your invigilator.",
      buttons: ["Close"],
    });
    releaseSitting();
    app.quit();
    return;
  }

  if (!mainWindow) mainWindow = createWindow(outcome.sitting.origin);

  /**
   * The displays, counted now and watched afterwards (Phase 15a).
   *
   * Until now this was a line in a console nobody can open. The count
   * reaching the server matters for two reasons the readiness check
   * cannot cover: `screen.isExtended` in a page is Chromium-only and easy
   * to falsify (`docs/EXAM-BROWSER.md` §3), and a monitor plugged in
   * twenty minutes after the clock started is exactly the case the
   * readiness check is blind to by construction.
   *
   * Reported, never refused. `docs/PROCTORING.md` §3 holds for everything
   * this application sees: an extra screen is a line a reviewer reads.
   */
  const countDisplays = () => screen.getAllDisplays().length;
  let lastDisplayCount = countDisplays();
  if (displayReport(lastDisplayCount).worthReporting) signals.displays(lastDisplayCount);

  const watchDisplays = () => {
    const count = countDisplays();
    if (count === lastDisplayCount) return;
    lastDisplayCount = count;
    // Every change, including going back to one: a reviewer reading "two
    // screens" without "and then one again" is reading half of it.
    signals.displays(count);
  };
  screen.on("display-added", watchDisplays);
  screen.on("display-removed", watchDisplays);
  signals.start();

  await mainWindow.loadURL(`${outcome.sitting.origin}${readinessPath(outcome.sitting.assessmentSlug)}`);
}

/**
 * Sign this window in, once, with the session the exchange handed back.
 *
 * The token goes from the exchange response into Chromium's cookie store
 * for the exam origin and nowhere else: it is not logged, not written to a
 * file, and not exposed through the preload. `sessionCookieFor` builds the
 * record and holds the rules (`httpOnly`, `secure` following the scheme);
 * this is the one line that applies it.
 */
async function placeSessionCookie(sitting: Sitting): Promise<boolean> {
  try {
    await examSession().cookies.set(
      sessionCookieFor({
        origin: sitting.origin,
        token: sitting.sessionToken,
        expiresAtMs: sitting.sessionExpiresAtMs,
      }),
    );
    return true;
  } catch (error) {
    // The name of the failure, never the value that failed to be set.
    console.error("[exam-browser] could not open the sitting:", error instanceof Error ? error.name : "unknown");
    return false;
  }
}

app.on("second-instance", (_event, argv) => {
  const url = launchUrlIn(argv);
  if (mainWindow) {
    mainWindow.focus();
    return;
  }
  if (url) void openSitting(url);
});

// macOS hands the URL over this way rather than in argv.
app.on("open-url", (event, url) => {
  event.preventDefault();
  if (!mainWindow) void openSitting(url);
});

ipcMain.handle("recx:version", () => APP_VERSION);
ipcMain.handle("recx:displays", () => screen.getAllDisplays().length);
ipcMain.on("recx:finish", () => {
  /**
   * The last flush, before the key is forgotten.
   *
   * It is awaited rather than fired and forgotten: after `releaseSitting`
   * there is nothing left to sign with, so a batch still in the queue can
   * never be sent. A paper handed in while the window was away still
   * carries the fact that it was away.
   */
  signals.closeOpenFocusLoss();
  void signals
    .flush()
    .catch(() => undefined)
    .finally(() => {
      signals.stop();
      releaseSitting();
      app.quit();
    });
});

app.whenReady().then(async () => {
  attachAttestation();
  /**
   * A development build says so before it shows anything, every launch.
   * It is modal and it is first: by the time a window is up it is wearing
   * the college's name full screen, and a person who installed this by
   * accident has already been given a reason to trust it.
   */
  if (buildIdentity().channel === "development") {
    await dialog.showMessageBox({
      type: "warning",
      title: DEVELOPMENT_BUILD_WARNING.title,
      message: DEVELOPMENT_BUILD_WARNING.message,
      detail: DEVELOPMENT_BUILD_WARNING.detail,
      buttons: ["Continue"],
    });
  }
  const url = launchUrlIn(process.argv);
  if (!url) {
    await dialog.showMessageBox({
      type: "info",
      title: "REC Exam Browser",
      message:
        "Start your exam from REC Code. Open the assessment, go to the readiness check, and press Launch REC Exam Browser.",
      buttons: ["Close"],
    });
    app.quit();
    return;
  }
  await openSitting(url);
});

/**
 * Quitting is the whole story. No tray icon, no background service, no
 * window kept alive on macOS — `docs/EXAM-BROWSER.md` §4 draws the line
 * between an exam browser and the desktop agent `docs/PROCTORING.md` §5
 * forbids at persistence, and this is where it is kept.
 */
app.on("window-all-closed", () => {
  releaseSitting();
  clipboard.clear();
  app.quit();
});

app.on("will-quit", () => {
  // Nothing is sent from here: `will-quit` does not wait, and a promise
  // started now would be cut off mid-flight. The orderly path is
  // `recx:finish` above; this is the one that guarantees the key is gone.
  signals.stop();
  releaseSitting();
  clipboard.clear();
});
