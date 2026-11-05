import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RELEASE_ORIGINS, APP_VERSION, DEV_ORIGIN_VARIABLE } from "../src/config";
import {
  REFUSED_PERMISSIONS,
  allowedOrigins,
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

  it("lets a development build add one, because this repository runs on localhost", () => {
    expect(allowedOrigins({ packaged: false, environment: { [DEV_ORIGIN_VARIABLE]: "http://localhost:3000" } })).toEqual(
      ["http://localhost:3000", ...RELEASE_ORIGINS],
    );
  });

  it("ignores a development value that is not a URL rather than failing to start", () => {
    expect(allowedOrigins({ packaged: false, environment: { [DEV_ORIGIN_VARIABLE]: "not a url" } })).toEqual(
      RELEASE_ORIGINS,
    );
    expect(allowedOrigins({ packaged: false, environment: {} })).toEqual(RELEASE_ORIGINS);
  });

  it("ships with at least one origin, so a build is never pointable anywhere", () => {
    expect(RELEASE_ORIGINS.length).toBeGreaterThan(0);
    for (const origin of RELEASE_ORIGINS) expect(new URL(origin).protocol).toBe("https:");
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
