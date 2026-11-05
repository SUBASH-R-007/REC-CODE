import { fileURLToPath } from "node:url";
import path from "node:path";
import { BrowserWindow, app, clipboard, dialog, ipcMain, screen, session } from "electron";
import { EXAM_BROWSER_SCHEME } from "@recx/shared/exam-browser";
import { APP_VERSION, WINDOW, readinessPath } from "./config";
import { LAUNCH_FAILURE_MESSAGES, exchange, launchUrlIn } from "./launch";
import { allowedOrigins, displayReport, navigationDecision, permissionDecision, shouldAttest, startupDecision } from "./policy";
import { attestationHeaders, heldSitting, holdSitting, releaseSitting } from "./sitting";

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
 *      is sent anywhere, then the token is exchanged for a sitting key.
 *   3. A window opens on the readiness page of that origin and can reach
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

app.setAsDefaultProtocolClient(EXAM_BROWSER_SCHEME);

let mainWindow: BrowserWindow | null = null;
/** Set once, by the first launch URL we successfully exchange. */
let origins: readonly string[] = [];

function originsForThisBuild(): readonly string[] {
  if (origins.length === 0) origins = allowedOrigins({ packaged: app.isPackaged, environment: process.env });
  return origins;
}

/**
 * The window every candidate sits in.
 *
 * Each option here is load-bearing and the comments say which rule it
 * serves, because a `webPreferences` object is exactly the kind of thing
 * somebody relaxes while debugging and forgets.
 */
function createWindow(origin: string): BrowserWindow {
  const window = new BrowserWindow({
    show: false,
    fullscreen: true,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: WINDOW.backgroundColor,
    minWidth: WINDOW.minWidth,
    minHeight: WINDOW.minHeight,
    webPreferences: {
      preload: path.join(DIRNAME, "preload.js"),
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

  window.once("ready-to-show", () => window.show());
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
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
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
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permissionDecision(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => permissionDecision(permission));
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

  if (!mainWindow) mainWindow = createWindow(outcome.sitting.origin);
  const displays = displayReport(screen.getAllDisplays().length);
  if (displays.worthReporting) {
    // Reported, never refused: PROCTORING.md §3 holds for everything this
    // application sees, so an extra screen is a line a reviewer reads.
    console.warn(`[exam-browser] ${displays.extra} display(s) beyond the primary`);
  }

  await mainWindow.loadURL(`${outcome.sitting.origin}${readinessPath(outcome.sitting.assessmentSlug)}`);
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
  releaseSitting();
  app.quit();
});

app.whenReady().then(async () => {
  attachAttestation();
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
  releaseSitting();
  clipboard.clear();
});
