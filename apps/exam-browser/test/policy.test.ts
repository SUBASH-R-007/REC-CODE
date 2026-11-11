import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  RELEASE_BUILD,
  RELEASE_ORIGINS,
  APP_VERSION,
  DEV_ORIGIN_VARIABLE,
  buildIdentity,
  readBakedBuild,
} from "../src/config";
import { examBrowserLaunchUrl, parseExamBrowserLaunchUrl } from "@recx/shared/exam-browser";
import {
  COVERAGE_TOLERANCE_PX,
  LOOPBACK_DEV_ORIGINS,
  REFUSED_PERMISSIONS,
  allowedOrigins,
  coversDisplay,
  blockedChord,
  displayReport,
  isExamOrigin,
  navigationDecision,
  permissionDecision,
  shouldAttest,
  startupDecision,
} from "../src/policy";

/**
 * The rules REC Exam Browser enforces (Phase 14c).
 *
 * Every one of them is a plain function over plain values, which is the
 * point: a kiosk browser whose guarantees can only be checked by starting
 * a browser is a kiosk browser whose guarantees nobody checks.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEV_BUILD = { channel: "development" as const, origins: ["http://localhost:3000"] };
const TOKEN = "t".repeat(48);

describe("which origins this build may be pointed at", () => {
  it("uses the compiled list and nothing else once packaged", () => {
    /**
     * The one that must never regress. A custom scheme is registered
     * system-wide, so any page the candidate visits can open
     * `recx-exam://launch?origin=…`. If a packaged build honoured an
     * environment variable, anyone who could set one could point the
     * college's own signed application at their own server.
     */
    expect(
      allowedOrigins({ packaged: true, environment: { [DEV_ORIGIN_VARIABLE]: "https://evil.test" } }),
    ).toEqual(RELEASE_ORIGINS);
  });

  it("ignores the environment even in a packaged DEVELOPMENT build", () => {
    /**
     * The rule is about packaging, not about the channel. A development
     * build is still an installed application that the operating system
     * starts from a URL any page can open, so the only thing that widens
     * it is what was compiled in -- and that took a deliberate build.
     */
    expect(
      allowedOrigins({
        packaged: true,
        build: DEV_BUILD,
        environment: { [DEV_ORIGIN_VARIABLE]: "https://evil.test" },
      }),
    ).toEqual(["http://localhost:3000", ...RELEASE_ORIGINS]);
  });

  it("lets a packaged development build reach what it was built for", () => {
    expect(allowedOrigins({ packaged: true, build: DEV_BUILD })).toEqual([
      "http://localhost:3000",
      ...RELEASE_ORIGINS,
    ]);
  });

  it("ignores origins baked into a RELEASE build, which should never have any", () => {
    // Belt and braces: the channel decides, so a release artifact built
    // from a tampered bundler config still refuses everything new.
    expect(
      allowedOrigins({ packaged: true, build: { channel: "release", origins: ["https://evil.test"] } }),
    ).toEqual(RELEASE_ORIGINS);
  });

  it("keeps the release origins in a development build, never replacing them", () => {
    // A build that could reach a laptop but not the real deployment is one
    // nobody could rehearse a real launch with.
    for (const origin of RELEASE_ORIGINS) {
      expect(allowedOrigins({ packaged: true, build: DEV_BUILD })).toContain(origin);
    }
  });

  it("does not list an origin twice when the two lists overlap", () => {
    const list = allowedOrigins({ packaged: true, build: { channel: "development", origins: RELEASE_ORIGINS.slice(0, 1) } });
    expect(list).toEqual(RELEASE_ORIGINS);
  });

  it("lets an unpackaged run add one, because this repository runs on localhost", () => {
    expect(allowedOrigins({ packaged: false, environment: { [DEV_ORIGIN_VARIABLE]: "http://dev.test:3000" } })).toEqual(
      ["http://dev.test:3000", ...LOOPBACK_DEV_ORIGINS, ...RELEASE_ORIGINS],
    );
  });

  it("takes the origin alone from a development value, not a path on it", () => {
    expect(
      allowedOrigins({ packaged: false, environment: { [DEV_ORIGIN_VARIABLE]: "http://dev.test:3000/anything" } }),
    ).toEqual(["http://dev.test:3000", ...LOOPBACK_DEV_ORIGINS, ...RELEASE_ORIGINS]);
  });

  it("ignores a development value that is not a URL rather than failing to start", () => {
    expect(allowedOrigins({ packaged: false, environment: { [DEV_ORIGIN_VARIABLE]: "not a url" } })).toEqual([
      ...LOOPBACK_DEV_ORIGINS,
      ...RELEASE_ORIGINS,
    ]);
    expect(allowedOrigins({ packaged: false, environment: {} })).toEqual([
      ...LOOPBACK_DEV_ORIGINS,
      ...RELEASE_ORIGINS,
    ]);
  });

  /**
   * Phase 15c. The hole this closes was not in the allowlist, it was in
   * where the allowlist got its development origin from.
   *
   * `recx-exam://` is registered with the operating system, and an OS
   * launch carries none of the shell environment of whoever is logged in
   * -- so `RECX_EXAM_DEV_ORIGIN` is empty in exactly the situation it was
   * added for. Pressing Launch on one's own dev server opened the
   * registered handler with no environment at all and produced the
   * candidate's "this launch pointed somewhere this exam browser is not
   * allowed to go", from a build that was doing its job.
   *
   * Loopback needs nothing to name it, so an unpackaged run takes it
   * without being told.
   */
  it("reaches a dev server on this machine with no environment whatsoever", () => {
    const list = allowedOrigins({ packaged: false });
    for (const port of ["3000", "3100", "5173", "8080"]) {
      for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
        expect(
          parseExamBrowserLaunchUrl(
            examBrowserLaunchUrl({ origin: `http://${host}:${port}`, token: TOKEN }),
            list,
          ),
          `${host}:${port}`,
        ).toEqual({ ok: true, origin: `http://${host}:${port}`, token: TOKEN });
      }
    }
  });

  it("does not list a loopback development value twice", () => {
    // It is already covered by the wildcards, and this list can end up in
    // front of a candidate.
    expect(
      allowedOrigins({ packaged: false, environment: { [DEV_ORIGIN_VARIABLE]: "http://localhost:3000" } }),
    ).toEqual([...LOOPBACK_DEV_ORIGINS, ...RELEASE_ORIGINS]);
  });

  it("gives a PACKAGED build no loopback at all, whatever channel it is", () => {
    /**
     * The whole point of the development channel is that what a packaged
     * build may reach took a deliberate build to put there. A packaged
     * build that silently accepted loopback would be one a page could
     * point at a server started on the candidate's own machine.
     */
    for (const build of [RELEASE_BUILD, DEV_BUILD, undefined]) {
      const list = allowedOrigins({ packaged: true, build });
      expect(list.some((entry) => entry.endsWith(":*")), JSON.stringify(build)).toBe(false);
      expect(
        parseExamBrowserLaunchUrl(
          examBrowserLaunchUrl({ origin: "http://localhost:9999", token: TOKEN }),
          list,
        ),
      ).toEqual({ ok: false, reason: "bad_origin" });
    }
  });

  it("cannot have a wildcard compiled into it, because a bake goes through URL", () => {
    // `new URL("http://localhost:*")` throws, so `readBakedBuild` drops it
    // -- which is why the syntax is safe to teach the shared parser.
    expect(readBakedBuild({ channel: "development", origins: LOOPBACK_DEV_ORIGINS })).toEqual({
      channel: "development",
      origins: [],
    });
  });

  it("ships with at least one origin, so a build is never pointable anywhere", () => {
    expect(RELEASE_ORIGINS.length).toBeGreaterThan(0);
    for (const origin of RELEASE_ORIGINS) expect(new URL(origin).protocol).toBe("https:");
  });
});

describe("what kind of build this is", () => {
  it("is a release when nothing was baked in, which is how the tests run", () => {
    // The constant only exists in a bundle. Unbundled -- here -- the
    // reader must fall to the safe side rather than throwing.
    expect(buildIdentity()).toEqual(RELEASE_BUILD);
    expect(RELEASE_BUILD.origins).toEqual([]);
  });

  it("falls to a release for anything it cannot read", () => {
    for (const value of [undefined, null, "development", 7, [], {}, { channel: "dev" }, { channel: "release" }]) {
      expect(readBakedBuild(value), JSON.stringify(value) ?? "undefined").toEqual(RELEASE_BUILD);
    }
  });

  it("reads a development bake, keeping only the origins it can parse", () => {
    expect(
      readBakedBuild({ channel: "development", origins: ["http://localhost:3000/x", "not a url", 7, null] }),
    ).toEqual({ channel: "development", origins: ["http://localhost:3000"] });
  });

  it("accepts a development bake with no usable origin, which then reaches only the release origins", () => {
    const build = readBakedBuild({ channel: "development", origins: ["not a url"] });
    expect(build.origins).toEqual([]);
    expect(allowedOrigins({ packaged: true, build })).toEqual(RELEASE_ORIGINS);
  });
});

describe("where the window may navigate", () => {
  const ORIGIN = "https://code.rec.edu.in";

  it("allows the exam origin", () => {
    expect(navigationDecision(`${ORIGIN}/assessments/x/readiness`, ORIGIN)).toEqual({ allow: true });
    expect(isExamOrigin(`${ORIGIN}/anything?q=1`, ORIGIN)).toBe(true);
  });

  it("refuses anywhere else, including a near miss", () => {
    for (const url of [
      "https://code.rec.edu.in.evil.test/",
      "https://evil.test/",
      "http://code.rec.edu.in/",
      "https://code.rec.edu.in:8443/",
    ]) {
      expect(navigationDecision(url, ORIGIN), url).toEqual({ allow: false, reason: "off_origin" });
    }
  });

  it("refuses the schemes that would leave the browser entirely", () => {
    /**
     * `mailto:`, `tel:` and friends hand the URL to the operating system,
     * which opens another application over a sitting in progress. It is
     * the one way a page inside a kiosk window can still put something
     * else on the candidate's screen.
     */
    for (const url of ["mailto:someone@example.test", "tel:+10000000", "file:///C:/Windows/system32", "ms-settings:"]) {
      expect(navigationDecision(url, ORIGIN), url).toMatchObject({ allow: false });
    }
  });

  it("refuses what it cannot parse rather than guessing", () => {
    expect(navigationDecision("://///", ORIGIN)).toEqual({ allow: false, reason: "unparseable" });
  });
});

describe("what a page may be granted", () => {
  it("grants nothing at all", () => {
    for (const permission of REFUSED_PERMISSIONS) {
      expect(permissionDecision(permission), permission).toBe(false);
    }
    // Including one nobody has thought of yet.
    expect(permissionDecision("some-permission-chromium-adds-in-2027")).toBe(false);
  });

  it("names the three docs/PROCTORING.md §5 forbids, so removing one is visible", () => {
    expect(REFUSED_PERMISSIONS).toContain("media");
    expect(REFUSED_PERMISSIONS).toContain("display-capture");
    expect(REFUSED_PERMISSIONS).toContain("clipboard-read");
  });
});

describe("which requests carry the attestation", () => {
  const ORIGIN = "https://code.rec.edu.in";

  it("signs requests to the exam origin", () => {
    expect(shouldAttest(`${ORIGIN}/api/exam/a/hb`, ORIGIN)).toBe(true);
  });

  it("signs nothing going anywhere else", () => {
    /**
     * An attestation is a credential. Attaching it to a request going
     * off-origin hands it to whoever is there — the same mistake as a
     * bearer token on a cross-origin fetch. Navigation should already
     * have refused the request; this is the second lock.
     */
    for (const url of ["https://evil.test/collect", "https://code.rec.edu.in.evil.test/", "http://code.rec.edu.in/"]) {
      expect(shouldAttest(url, ORIGIN), url).toBe(false);
    }
  });
});

describe("the command line it refuses to start with", () => {
  it("starts on an ordinary launch", () => {
    expect(startupDecision(["recx-exam.exe", "recx-exam://launch?origin=https%3A%2F%2Fe.test&token=abc"])).toEqual({
      ok: true,
    });
  });

  it("refuses the remote debugger and the extension loader", () => {
    expect(startupDecision(["recx-exam.exe", "--remote-debugging-port=9222"])).toMatchObject({
      ok: false,
      switches: ["remote-debugging-port"],
    });
    expect(startupDecision(["recx-exam.exe", "--load-extension=/tmp/x"])).toMatchObject({
      ok: false,
      switches: ["load-extension"],
    });
  });

  it("refuses rather than strips, so nobody sits a paper in a browser that quietly differs", () => {
    const decision = startupDecision(["recx-exam.exe", "--disable-web-security", "--no-sandbox"]);
    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.switches).toEqual(["disable-web-security", "no-sandbox"]);
  });
});

describe("counting displays", () => {
  it("says nothing about one screen", () => {
    expect(displayReport(1)).toEqual({ extra: 0, worthReporting: false });
  });

  it("counts the extras", () => {
    expect(displayReport(3)).toEqual({ extra: 2, worthReporting: true });
  });

  it("never reports a negative, whatever the platform says", () => {
    expect(displayReport(0)).toEqual({ extra: 0, worthReporting: false });
  });
});

describe("the version this build reports", () => {
  it("matches package.json, because the deployment's floor is compared against it", () => {
    // A build that lied about its version would be a build that could not
    // be cut off when it turned out to be bad.
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string };
    expect(APP_VERSION).toBe(pkg.version);
  });
});

describe("the keys the window swallows (Phase 14j)", () => {
  const chord = (over: Partial<Parameters<typeof blockedChord>[0]>) =>
    blockedChord({ key: "a", control: false, meta: false, alt: false, shift: false, ...over });

  it("swallows the ways out of one window", () => {
    for (const key of ["n", "t", "w", "o"]) {
      expect(chord({ key, control: true }), `ctrl+${key}`).toBe(true);
      expect(chord({ key, meta: true }), `cmd+${key}`).toBe(true);
    }
  });

  it("swallows the ways to take the paper somewhere else", () => {
    // Print and save both write the questions somewhere the sitting does
    // not reach; view source opens a second view of the page that none of
    // the window's rules apply to.
    for (const key of ["p", "s", "u"]) expect(chord({ key, control: true }), key).toBe(true);
  });

  it("swallows the developer tools, which are already off", () => {
    expect(chord({ key: "F12" })).toBe(true);
    for (const key of ["i", "j", "c"]) {
      expect(chord({ key, control: true, shift: true }), `ctrl+shift+${key}`).toBe(true);
    }
  });

  it("swallows the fullscreen toggle, because the window chooses its own", () => {
    expect(chord({ key: "F11" })).toBe(true);
  });

  it("lets a candidate reload, because a kiosk that cannot recover ends a paper", () => {
    /**
     * Deliberately absent. The exam page snapshots answers continuously,
     * so a reload costs nothing, and a candidate whose page has wedged
     * has no other way out of it.
     */
    expect(chord({ key: "r", control: true })).toBe(false);
    expect(chord({ key: "F5" })).toBe(false);
    expect(chord({ key: "r", control: true, shift: true })).toBe(false);
  });

  it("lets copy, cut and paste through, which the charter settled first", () => {
    // docs/PROCTORING.md §2: paste is instrumented, not blocked.
    for (const key of ["c", "x", "v"]) expect(chord({ key, control: true }), key).toBe(false);
  });

  it("lets zoom and Escape through", () => {
    for (const key of ["+", "-", "0"]) expect(chord({ key, control: true }), key).toBe(false);
    expect(chord({ key: "Escape" })).toBe(false);
  });

  it("ignores case, because Chromium reports the shifted key", () => {
    expect(chord({ key: "W", control: true })).toBe(true);
    expect(chord({ key: "f12" })).toBe(true);
  });

  it("does not swallow an ordinary letter a candidate is typing", () => {
    for (const key of ["a", "w", "p", "s", "n", "u", "o"]) {
      expect(chord({ key }), key).toBe(false);
      expect(chord({ key, shift: true }), `shift+${key}`).toBe(false);
    }
  });
});
/**
 * Is the window actually over the whole screen? (Phase 15d)
 *
 * The reason this is a function with tests rather than a call to
 * `isFullScreen()` is that `isFullScreen()` was wrong. Built with
 * `resizable: false`, the exam window opened at 1036x647 on a 1536x960
 * screen -- the minimum size plus an invisible resize border, because on
 * Windows that option becomes size constraints and the fullscreen
 * request is clamped by them -- and both `isFullScreen()` and
 * `isKiosk()` returned true the whole time. The desktop, and anything a
 * candidate had left on it, was visible around a paper an invigilator
 * believed was sealed.
 *
 * So the question is asked in pixels.
 */
describe("whether the window covers its screen", () => {
  const SCREEN = { x: 0, y: 0, width: 1536, height: 960 };

  it("says yes to a window exactly over the screen", () => {
    expect(coversDisplay(SCREEN, SCREEN)).toBe(true);
  });

  it("says no to the window this bug actually produced", () => {
    // Measured from a real Electron, not invented: 1024 + 12 of invisible
    // resize border, 640 + 7, parked at the origin.
    expect(coversDisplay({ x: 0, y: 0, width: 1036, height: 647 }, SCREEN)).toBe(false);
  });

  it("says no when any one edge leaves the screen uncovered", () => {
    const short = COVERAGE_TOLERANCE_PX + 1;
    expect(coversDisplay({ ...SCREEN, width: SCREEN.width - short }, SCREEN), "right edge").toBe(false);
    expect(coversDisplay({ ...SCREEN, height: SCREEN.height - short }, SCREEN), "bottom edge").toBe(false);
    expect(coversDisplay({ ...SCREEN, x: short }, SCREEN), "left edge").toBe(false);
    expect(coversDisplay({ ...SCREEN, y: short }, SCREEN), "top edge").toBe(false);
  });

  it("tolerates a rounding pixel, because DIP bounds are rounded on both sides", () => {
    // A correct fullscreen window can sit a pixel out on a fractional
    // scale factor. A fence that fought that would re-assert fullscreen
    // in a loop for the whole paper.
    expect(coversDisplay({ x: 1, y: 1, width: SCREEN.width - 2, height: SCREEN.height - 2 }, SCREEN)).toBe(true);
  });

  it("says yes to a window larger than the screen", () => {
    // Which is what a fullscreen window on some window managers is.
    expect(coversDisplay({ x: -4, y: -4, width: SCREEN.width + 8, height: SCREEN.height + 8 }, SCREEN)).toBe(true);
  });

  it("works on a display that is not at the origin", () => {
    // A second monitor to the right. A window still at 0,0 covers the
    // PRIMARY screen and none of this one.
    const second = { x: 1536, y: 0, width: 1920, height: 1080 };
    expect(coversDisplay(second, second)).toBe(true);
    expect(coversDisplay({ x: 0, y: 0, width: 1536, height: 960 }, second)).toBe(false);
  });

  it("keeps the tolerance far below anything a person could see through", () => {
    expect(COVERAGE_TOLERANCE_PX).toBeLessThanOrEqual(4);
    expect(COVERAGE_TOLERANCE_PX).toBeGreaterThan(0);
  });
});
