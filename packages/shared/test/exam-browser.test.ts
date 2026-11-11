import { describe, expect, it } from "vitest";
import {
  EXAM_BROWSER_LOOPBACK_HOSTS,
  EXAM_BROWSER_PROTOCOL_VERSION,
  EXAM_BROWSER_REFUSALS,
  EXAM_BROWSER_REFUSAL_MESSAGES,
  EXAM_BROWSER_REFUSED_SWITCHES,
  EXAM_BROWSER_SKEW_TOLERANCE_MS,
  examBrowserLaunchUrl,
  examBrowserSigningInput,
  examBrowserUrlFor,
  meetsVersionFloor,
  parseExamBrowserLaunchUrl,
  parseVersion,
  refusedSwitches,
  verifyExamBrowser,
  type ExamBrowserPresented,
} from "../src/exam-browser";

/**
 * REC Exam Browser attestation (Phase 14a).
 *
 * The module is pure, so every rule in `docs/EXAM-BROWSER.md` §5 is tested
 * as the decision it is. Two of them are load-bearing in a way that is easy
 * to miss and are tested hardest: the launch URL's origin allowlist, which
 * is the difference between a kiosk browser and a signed phishing window,
 * and the fact that nothing here records a nonce — because a replay check
 * done in the wrong order is a way to end an honest candidate's sitting
 * from outside.
 */

/** Deterministic and obviously not a real HMAC, which is the point of injecting it. */
const hmac = (key: string, message: string) => `sig(${key}|${message.replace(/\n/g, "~")})`;

const SITTING = "sitting_7f3a";
const KEY = "k-abc123";
const NOW = 1_762_300_000_000;

const signed = (over: Partial<ExamBrowserPresented> = {}, at = NOW): ExamBrowserPresented => {
  const nonce = "n-0001";
  const base = {
    protocol: String(EXAM_BROWSER_PROTOCOL_VERSION),
    version: "1.0.0",
    sittingId: SITTING,
    nonce,
    timestamp: String(at),
    signature: hmac(
      KEY,
      examBrowserSigningInput({
        method: "POST",
        url: "https://exam.test/api/exam/heartbeat",
        nonce,
        timestamp: at,
        sittingId: SITTING,
      }),
    ),
  };
  return { ...base, ...over };
};

const verify = (presented: ExamBrowserPresented, over: Partial<Parameters<typeof verifyExamBrowser>[0]> = {}) =>
  verifyExamBrowser({
    method: "POST",
    url: "https://exam.test/api/exam/heartbeat",
    presented,
    sittingKey: KEY,
    versionFloor: null,
    now: NOW,
    hmac,
    ...over,
  });

describe("the string both ends sign", () => {
  it("names the protocol version, so a signature cannot carry across a format change", () => {
    expect(
      examBrowserSigningInput({
        method: "get",
        url: "https://exam.test/a",
               nonce: "n",
        timestamp: 10,
        sittingId: "s",
      }),
    ).toBe(["recx-exam/v1", "GET", "https://exam.test/a", "n", "10", "s"].join("\n"));
  });

  it("upper-cases the method, so a request cannot be replayed as a different verb", () => {
    const get = examBrowserSigningInput({ method: "get", url: "https://e.test/a", nonce: "n", timestamp: 1, sittingId: "s" });
    const post = examBrowserSigningInput({ method: "POST", url: "https://e.test/a", nonce: "n", timestamp: 1, sittingId: "s" });
    expect(get).not.toBe(post);
    expect(get).toBe(examBrowserSigningInput({ method: "GET", url: "https://e.test/a", nonce: "n", timestamp: 1, sittingId: "s" }));
  });

  it("leaves no empty line, so no field can absorb the one beside it", () => {
    const line = examBrowserSigningInput({ method: "GET", url: "https://e.test/a", nonce: "n", timestamp: 1, sittingId: "s" });
    expect(line).not.toContain("\n\n");
    expect(line.split("\n")).toHaveLength(6);
  });

  it("does not sign the body, and the nonce is what makes a signature single-use", () => {
    /**
     * The first draft signed a hash of the body. It came out for two
     * reasons worth keeping. The server cannot reproduce the bytes the
     * client hashed — three exam routes parse the body before the attempt
     * guard runs, and a parsed body does not re-serialise to the text that
     * arrived. And it was defending against nobody: the adversary holds
     * the key and can sign whatever body they like, while altering a
     * request in flight is TLS's problem. A signed field the server cannot
     * check reads like protection that is not there.
     */
    const a = examBrowserSigningInput({ method: "POST", url: "https://e.test/a", nonce: "n1", timestamp: 1, sittingId: "s" });
    const b = examBrowserSigningInput({ method: "POST", url: "https://e.test/a", nonce: "n2", timestamp: 1, sittingId: "s" });
    expect(a).not.toBe(b);
  });

  it("signs the query, unlike SEB, because we write both ends", () => {
    const a = examBrowserSigningInput({ method: "GET", url: "https://e.test/a?page=1", nonce: "n", timestamp: 1, sittingId: "s" });
    const b = examBrowserSigningInput({ method: "GET", url: "https://e.test/a?page=2", nonce: "n", timestamp: 1, sittingId: "s" });
    expect(a).not.toBe(b);
  });
});

describe("the URL that gets signed", () => {
  it("drops a fragment, which never reaches the server anyway", () => {
    expect(examBrowserUrlFor("https://exam.test/a?b=1#frag")).toBe("https://exam.test/a?b=1");
  });

  it("agrees about two spellings of one address", () => {
    expect(examBrowserUrlFor("https://EXAM.Test:443/a")).toBe(examBrowserUrlFor("https://exam.test/a"));
  });

  it("hands back anything it cannot parse rather than throwing mid-exam", () => {
    expect(examBrowserUrlFor("not a url")).toBe("not a url");
  });
});

describe("verifying a request", () => {
  it("accepts one the browser signed, and reports the version for the audit row", () => {
    expect(verify(signed())).toEqual({ ok: true, sittingId: SITTING, nonce: "n-0001", version: "1.0.0" });
  });

  it("tells an ordinary browser something it can act on", () => {
    const verdict = verify({ protocol: null, version: null, sittingId: null, nonce: null, timestamp: null, signature: null });
    expect(verdict).toEqual({ ok: false, refusal: "absent", message: EXAM_BROWSER_REFUSAL_MESSAGES.absent });
  });

  it("separates a half-built request from an honest browser", () => {
    // Some headers but not all: not an ordinary browser, and not a wrong
    // signature either. The sentence differs because the fix differs.
    expect(verify(signed({ nonce: null })).ok).toBe(false);
    expect(verify(signed({ nonce: null }))).toMatchObject({ refusal: "malformed" });
    expect(verify(signed({ timestamp: "soon" }))).toMatchObject({ refusal: "malformed" });
    expect(verify(signed({ protocol: "one" }))).toMatchObject({ refusal: "malformed" });
    expect(verify(signed({ version: "1.0" }))).toMatchObject({ refusal: "malformed" });
  });

  it("refuses a wire format it does not speak", () => {
    expect(verify(signed({ protocol: "2" }))).toMatchObject({ refusal: "protocol_unsupported" });
  });

  it("refuses a build below the floor, and accepts the floor itself", () => {
    expect(verify(signed({ version: "1.3.9" }), { versionFloor: "1.4.0" })).toMatchObject({
      refusal: "version_below_floor",
    });
    expect(verify(signed({ version: "1.4.0" }), { versionFloor: "1.4.0" }).ok).toBe(true);
    expect(verify(signed({ version: "2.0.0" }), { versionFloor: "1.4.0" }).ok).toBe(true);
  });

  it("tolerates a clock that is out of step, and only so far", () => {
    const inside = EXAM_BROWSER_SKEW_TOLERANCE_MS - 1_000;
    expect(verify(signed({}, NOW - inside), { now: NOW }).ok).toBe(true);
    // Ahead as well as behind: a candidate's clock can be fast.
    expect(verify(signed({}, NOW + inside), { now: NOW }).ok).toBe(true);

    const outside = EXAM_BROWSER_SKEW_TOLERANCE_MS + 1_000;
    expect(verify(signed({}, NOW - outside), { now: NOW })).toMatchObject({ refusal: "expired" });
    expect(verify(signed({}, NOW + outside), { now: NOW })).toMatchObject({ refusal: "expired" });
  });

  it("says a sitting is gone rather than blaming the signature", () => {
    expect(verify(signed(), { sittingKey: null })).toMatchObject({ refusal: "unknown_sitting" });
    expect(verify(signed(), { sittingKey: "" })).toMatchObject({ refusal: "unknown_sitting" });
  });

  it("refuses a signature made for a different request", () => {
    // Everything the signature covers, one field at a time.
    expect(verify(signed(), { method: "GET" })).toMatchObject({ refusal: "mismatch" });
    expect(verify(signed(), { url: "https://exam.test/api/exam/submit" })).toMatchObject({ refusal: "mismatch" });
    expect(verify(signed({ nonce: "n-0002" }))).toMatchObject({ refusal: "mismatch" });
    expect(verify(signed({ sittingId: "sitting_other" }))).toMatchObject({ refusal: "mismatch" });
    expect(verify(signed(), { sittingKey: "k-someone-else" })).toMatchObject({ refusal: "mismatch" });
  });

  it("refuses a signature replayed onto a neighbouring timestamp", () => {
    // The timestamp is signed, so moving it invalidates the signature even
    // while it is still inside the tolerance window.
    const original = signed();
    expect(verify({ ...original, timestamp: String(NOW + 1_000) })).toMatchObject({ refusal: "mismatch" });
  });

  it("does not mind how a proxy cased or padded the hex", () => {
    const original = signed();
    expect(verify({ ...original, signature: `  ${original.signature!.toUpperCase()}  ` }).ok).toBe(true);
  });

  it("hands the nonce back instead of recording it, and the order is the reason", () => {
    /**
     * Nothing here remembers a nonce. If verification burned one before
     * checking the signature, anybody who can reach the exam URL could
     * spend the nonce the real browser is about to use and end a
     * candidate's sitting from outside. So the caller records it, after
     * this has said the signature holds.
     */
    const first = verify(signed());
    const second = verify(signed());
    expect(first).toEqual(second);
    expect(first.ok && first.nonce).toBe("n-0001");
  });

  it("has a sentence for every refusal it can reach", () => {
    for (const refusal of EXAM_BROWSER_REFUSALS) {
      expect(EXAM_BROWSER_REFUSAL_MESSAGES[refusal].length).toBeGreaterThan(20);
    }
  });

  it("never names the key, the token or the signature in what the candidate reads", () => {
    for (const message of Object.values(EXAM_BROWSER_REFUSAL_MESSAGES)) {
      expect(message).not.toMatch(/\b(key|token|signature|hmac)\b/i);
    }
  });
});

describe("versions", () => {
  it("reads the three numbers, and a release candidate as the version it says it is", () => {
    expect(parseVersion("1.4.0")).toEqual([1, 4, 0]);
    expect(parseVersion("1.4.0-rc.2")).toEqual([1, 4, 0]);
    expect(parseVersion("10.0.3")).toEqual([10, 0, 3]);
  });

  it("refuses what is not one", () => {
    for (const bad of ["1.4", "v1.4.0", "1.4.0.1", "", "latest", "1.4.x"]) {
      expect(parseVersion(bad), bad).toBeNull();
    }
  });

  it("compares by number, not by text", () => {
    // The bug this exists for: "1.10.0" sorts before "1.9.0" as a string.
    expect(meetsVersionFloor("1.10.0", "1.9.0")).toBe(true);
    expect(meetsVersionFloor("1.9.0", "1.10.0")).toBe(false);
    expect(meetsVersionFloor("2.0.0", "1.99.99")).toBe(true);
    expect(meetsVersionFloor("1.4.0", "1.4.0")).toBe(true);
  });

  it("treats an unreadable version as not meeting the floor", () => {
    expect(meetsVersionFloor("nonsense", "1.0.0")).toBe(false);
    expect(meetsVersionFloor("1.0.0", "nonsense")).toBe(false);
  });
});

describe("the launch URL", () => {
  const ALLOWED = ["https://exam.college.test"];

  it("round-trips an origin and a token", () => {
    const url = examBrowserLaunchUrl({ origin: "https://exam.college.test", token: "a".repeat(40) });
    expect(url.startsWith("recx-exam://launch?")).toBe(true);
    expect(parseExamBrowserLaunchUrl(url, ALLOWED)).toEqual({
      ok: true,
      origin: "https://exam.college.test",
      token: "a".repeat(40),
    });
  });

  it("refuses an origin the build was not shipped to talk to", () => {
    /**
     * The attack this stops: a custom scheme is registered system-wide, so
     * ANY page the candidate visits can open `recx-exam://launch`. Without
     * this check that page could start the college's own exam browser
     * pointed at a server the page controls — a window with no address bar,
     * wearing the college's application, asking for a college password.
     */
    const evil = examBrowserLaunchUrl({ origin: "https://exam.college.test.evil.test", token: "a".repeat(40) });
    expect(parseExamBrowserLaunchUrl(evil, ALLOWED)).toEqual({ ok: false, reason: "bad_origin" });
  });

  it("compares the parsed origin, so spelling tricks do not land", () => {
    for (const origin of [
      "https://exam.college.test.evil.test",
      "http://exam.college.test",
      "https://exam.college.test@evil.test",
      "https://evil.test/?x=https://exam.college.test",
      "https://exam.college.test.",
    ]) {
      const url = examBrowserLaunchUrl({ origin, token: "a".repeat(40) });
      expect(parseExamBrowserLaunchUrl(url, ALLOWED), origin).toMatchObject({ ok: false });
    }
  });

  it("accepts the same origin written differently", () => {
    const url = examBrowserLaunchUrl({ origin: "https://EXAM.college.test:443/", token: "a".repeat(40) });
    expect(parseExamBrowserLaunchUrl(url, ALLOWED)).toMatchObject({ ok: true, origin: "https://exam.college.test" });
  });

  it("refuses a token that is not one", () => {
    for (const token of ["", "short", "a".repeat(200), "has spaces in it".padEnd(40, "x"), `${"a".repeat(39)}/`]) {
      const url = examBrowserLaunchUrl({ origin: "https://exam.college.test", token });
      expect(parseExamBrowserLaunchUrl(url, ALLOWED), token).toEqual({ ok: false, reason: "bad_token" });
    }
  });

  it("refuses anything that is not a launch at all", () => {
    for (const url of ["https://exam.college.test/", "recx-exam://quit", "not a url", "recx-exam://launch-now"]) {
      expect(parseExamBrowserLaunchUrl(url, ALLOWED), url).toEqual({ ok: false, reason: "not_a_launch" });
    }
  });

  it("refuses everything when the build has no allowlist", () => {
    const url = examBrowserLaunchUrl({ origin: "https://exam.college.test", token: "a".repeat(40) });
    expect(parseExamBrowserLaunchUrl(url, [])).toEqual({ ok: false, reason: "bad_origin" });
  });
});

describe("the command line the application refuses to start with", () => {
  it("catches the two that matter most", () => {
    // Driving the exam from DevTools Protocol on another machine, and the
    // content script that lies about focus (PROCTORING.md §2).
    expect(refusedSwitches(["recx-exam.exe", "--remote-debugging-port=9222"])).toEqual(["remote-debugging-port"]);
    expect(refusedSwitches(["recx-exam.exe", "--load-extension=/tmp/liar"])).toEqual(["load-extension"]);
  });

  it("reads the name before the equals sign, in any spelling Chromium accepts", () => {
    expect(refusedSwitches(["-remote-debugging-port=9222"])).toEqual(["remote-debugging-port"]);
    expect(refusedSwitches(["--Remote-Debugging-Port"])).toEqual(["remote-debugging-port"]);
  });

  it("lets an ordinary launch through", () => {
    expect(refusedSwitches(["recx-exam.exe", "recx-exam://launch?origin=https://e.test&token=abc"])).toEqual([]);
    expect(refusedSwitches([])).toEqual([]);
  });

  it("names every one it found, once each, in the order given", () => {
    expect(
      refusedSwitches(["--disable-web-security", "--js-flags=--expose-gc", "--disable-web-security", "--no-sandbox"]),
    ).toEqual(["disable-web-security", "js-flags", "no-sandbox"]);
  });

  it("covers the categories the posture document names", () => {
    for (const expected of ["remote-debugging-port", "load-extension", "disable-web-security", "inspect", "user-data-dir"]) {
      expect(EXAM_BROWSER_REFUSED_SWITCHES).toContain(expected);
    }
  });
});
/**
 * The one wildcard the allowlist understands (Phase 15c).
 *
 * `http://localhost:*` means any port on this machine, and it exists
 * because the operating system launches the registered handler with none
 * of the environment that `RECX_EXAM_DEV_ORIGIN` lives in. Loopback is the
 * only thing a run can know about itself without being told.
 *
 * A wildcard in a parser that stands between a signed binary and a phishing
 * window is worth being paranoid about, so what is tested here is mostly
 * what it REFUSES: a wildcard on any host that is not loopback, a scheme
 * that does not match, and a host that merely ends in a loopback name.
 */
describe("a loopback wildcard in the allowlist", () => {
  const TOKEN = "t".repeat(48);
  const launch = (origin: string, allowed: readonly string[]) =>
    parseExamBrowserLaunchUrl(examBrowserLaunchUrl({ origin, token: TOKEN }), allowed);

  const LOOPBACK = Object.freeze(["http://localhost:*", "http://127.0.0.1:*", "http://[::1]:*"]);

  it("covers any port on this machine", () => {
    for (const origin of [
      "http://localhost:3000",
      "http://localhost:80",
      "http://127.0.0.1:5173",
      "http://[::1]:8080",
    ]) {
      // Through `URL`, so a default port normalises away: :80 is
      // `http://localhost`, which is the comparison the parser makes too.
      expect(launch(origin, LOOPBACK), origin).toEqual({
        ok: true,
        origin: new URL(origin).origin,
        token: TOKEN,
      });
    }
  });

  it("refuses a wildcard on a host that is not loopback, however it is spelled", () => {
    // The restriction is in the parser rather than only in the caller, so
    // a list assembled somewhere else cannot widen anything either.
    for (const entry of [
      "https://code.rec.edu.in:*",
      "http://evil.test:*",
      "http://notlocalhost:*",
      "http://localhost.evil.test:*",
      "http://0.0.0.0:*",
      "http://10.0.0.1:*",
    ]) {
      expect(launch("https://code.rec.edu.in", [entry]), entry).toEqual({ ok: false, reason: "bad_origin" });
      expect(launch("http://evil.test:3000", [entry]), entry).toEqual({ ok: false, reason: "bad_origin" });
    }
  });

  it("does not let a loopback wildcard reach anything but loopback", () => {
    for (const origin of [
      "https://code.rec.edu.in",
      "http://localhost.evil.test:3000",
      "http://evil.test:3000",
      "http://127.0.0.2:3000",
    ]) {
      expect(launch(origin, LOOPBACK), origin).toEqual({ ok: false, reason: "bad_origin" });
    }
  });

  it("holds the scheme, so an https page cannot borrow an http wildcard", () => {
    expect(launch("https://localhost:3000", LOOPBACK)).toEqual({ ok: false, reason: "bad_origin" });
  });

  it("leaves an ordinary entry an exact origin comparison", () => {
    // The `:*` suffix is the whole trigger: without it nothing changes,
    // including for a loopback host.
    expect(launch("http://localhost:3001", ["http://localhost:3000"])).toEqual({ ok: false, reason: "bad_origin" });
    expect(launch("http://localhost:3000", ["http://localhost:3000"])).toEqual({
      ok: true,
      origin: "http://localhost:3000",
      token: TOKEN,
    });
  });

  it("still refuses a bad token on a loopback origin", () => {
    expect(parseExamBrowserLaunchUrl("recx-exam://launch?origin=http://localhost:3000&token=x", LOOPBACK)).toEqual({
      ok: false,
      reason: "bad_token",
    });
  });

  it("spells the loopback hosts the way URL spells them", () => {
    // An IPv6 literal keeps its brackets in `hostname`; a list written
    // without them would silently match nothing.
    for (const host of EXAM_BROWSER_LOOPBACK_HOSTS) {
      expect(new URL(`http://${host}:3000`).hostname, host).toBe(host);
    }
  });
});
