import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SEB_CONFIG_KEY_HEADER,
  SEB_REFUSALS,
  SEB_REFUSAL_MESSAGES,
  SEB_REQUEST_HASH_HEADER,
  sebUrlFor,
  verifySeb,
} from "../src/seb";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const URL_UNDER_TEST = "https://code.rec.edu.in/assessments/mock-1/attempt";
const CONFIG_KEY = "config-key-abcdef0123456789";
const BROWSER_KEY = "browser-exam-key-9876543210";

const hashes = {
  config: sha256(URL_UNDER_TEST + CONFIG_KEY),
  browser: sha256(URL_UNDER_TEST + BROWSER_KEY),
};

const verify = (over: Partial<Parameters<typeof verifySeb>[0]> = {}) =>
  verifySeb({
    absoluteUrl: URL_UNDER_TEST,
    keys: { configKey: CONFIG_KEY, browserExamKey: BROWSER_KEY },
    presented: { configKeyHash: hashes.config, requestHash: hashes.browser },
    sha256,
    ...over,
  });

describe("the header names are the ones SEB sends", () => {
  it("is lower-case, as a Headers lookup returns them", () => {
    expect(SEB_CONFIG_KEY_HEADER).toBe("x-safeexambrowser-configkeyhash");
    expect(SEB_REQUEST_HASH_HEADER).toBe("x-safeexambrowser-requesthash");
    expect(SEB_CONFIG_KEY_HEADER).toBe(SEB_CONFIG_KEY_HEADER.toLowerCase());
    expect(SEB_REQUEST_HASH_HEADER).toBe(SEB_REQUEST_HASH_HEADER.toLowerCase());
  });
});

describe("verifySeb", () => {
  it("accepts correct hashes for both keys", () => {
    expect(verify()).toEqual({ ok: true, checked: "both" });
  });

  it("recomputes sha256(absoluteUrl + key), which is the whole check", () => {
    // Asserted against an independently computed digest, so a change to the
    // hash INPUT (the url, the concatenation order) fails here.
    const result = verify({
      presented: { configKeyHash: sha256(URL_UNDER_TEST + CONFIG_KEY), requestHash: null },
      keys: { configKey: CONFIG_KEY, browserExamKey: null },
    });
    expect(result).toEqual({ ok: true, checked: "config" });
  });

  it("refuses a request with no SEB headers as absent, not as a mismatch", () => {
    // An ordinary browser. The sentence a candidate needs is "open the .seb
    // file", which is different from "ask for the current exam file".
    const result = verify({ presented: { configKeyHash: null, requestHash: null } });
    expect(result).toEqual({ ok: false, refusal: "absent", message: SEB_REFUSAL_MESSAGES.absent });
  });

  it("refuses an empty header as absent", () => {
    expect(verify({ presented: { configKeyHash: "", requestHash: "   " } })).toMatchObject({ refusal: "absent" });
  });

  it("refuses a wrong config key hash", () => {
    expect(verify({ presented: { configKeyHash: sha256("wrong"), requestHash: hashes.browser } })).toMatchObject({
      ok: false,
      refusal: "mismatch",
    });
  });

  it("refuses a wrong browser exam key hash", () => {
    expect(verify({ presented: { configKeyHash: hashes.config, requestHash: sha256("wrong") } })).toMatchObject({
      ok: false,
      refusal: "mismatch",
    });
  });

  it("refuses a hash for a DIFFERENT url, which is the replay this prevents", () => {
    // Hashes computed for one exam's URL must not admit a request to another.
    const other = "https://code.rec.edu.in/assessments/other-exam/attempt";
    const result = verify({
      absoluteUrl: other,
      presented: { configKeyHash: hashes.config, requestHash: hashes.browser },
    });
    expect(result).toMatchObject({ ok: false, refusal: "mismatch" });
  });

  it("refuses when a configured key's header is missing, even if the other matches", () => {
    // Both keys configured means both are checked; one valid header is not
    // enough, or configuring two keys would be weaker than configuring one.
    expect(verify({ presented: { configKeyHash: hashes.config, requestHash: null } })).toMatchObject({
      ok: false,
      refusal: "mismatch",
    });
  });

  it("checks only the key that is configured", () => {
    expect(
      verify({
        keys: { configKey: null, browserExamKey: BROWSER_KEY },
        presented: { configKeyHash: null, requestHash: hashes.browser },
      }),
    ).toEqual({ ok: true, checked: "browser" });
  });

  it("refuses an assessment set to SEB with no keys at all", () => {
    // Setup mistake. Waving every browser through is the one outcome nobody
    // wants, so this is refused and the message says it is not the
    // candidate's fault.
    const result = verify({ keys: { configKey: null, browserExamKey: null } });
    expect(result).toMatchObject({ ok: false, refusal: "not_configured" });
    expect(SEB_REFUSAL_MESSAGES.not_configured).toContain("not something you have done");
  });

  it("tolerates a proxy that re-cases or pads the header", () => {
    expect(
      verify({ presented: { configKeyHash: ` ${hashes.config.toUpperCase()} `, requestHash: hashes.browser } }),
    ).toMatchObject({ ok: true });
  });

  it("has a sentence for every refusal, and accuses nobody", () => {
    for (const refusal of SEB_REFUSALS) {
      const message = SEB_REFUSAL_MESSAGES[refusal];
      expect(message.length).toBeGreaterThan(20);
      expect(message.toLowerCase()).not.toMatch(/cheat|malpractice|caught|violation/);
    }
    expect(Object.keys(SEB_REFUSAL_MESSAGES)).toHaveLength(SEB_REFUSALS.length);
  });
});

describe("sebUrlFor", () => {
  it("drops the query string, which a client could otherwise choose", () => {
    expect(sebUrlFor(`${URL_UNDER_TEST}?x=1&y=2`)).toBe(URL_UNDER_TEST);
  });

  it("drops the fragment", () => {
    expect(sebUrlFor(`${URL_UNDER_TEST}#q3`)).toBe(URL_UNDER_TEST);
  });

  it("leaves a clean url alone", () => {
    expect(sebUrlFor(URL_UNDER_TEST)).toBe(URL_UNDER_TEST);
  });

  it("keeps the path, the host and the scheme, which are what identify the exam", () => {
    const url = sebUrlFor("https://code.rec.edu.in:8443/assessments/a/attempt?z=9");
    expect(url).toBe("https://code.rec.edu.in:8443/assessments/a/attempt");
  });

  it("returns an unparseable input unchanged rather than throwing mid-request", () => {
    expect(sebUrlFor("not a url")).toBe("not a url");
  });

  it("makes a cache-busting parameter unable to break a candidate's exam", () => {
    const a = verify({ absoluteUrl: sebUrlFor(`${URL_UNDER_TEST}?_=1700000000`) });
    expect(a).toMatchObject({ ok: true });
  });
});
