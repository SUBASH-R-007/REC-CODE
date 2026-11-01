import { describe, expect, it } from "vitest";
import { buildSebConfig, sebLaunchUrl } from "../src/seb-config";

/**
 * The .seb file (Phase 12y.8).
 *
 * A configuration that is wrong in a small way is a room of candidates who
 * cannot start, ten minutes before an exam, with an invigilator holding a
 * file nobody can read. So the things that must be true of it are asserted
 * here rather than discovered then.
 */

const config = () =>
  buildSebConfig({
    startUrl: "https://rec.example/assessments/mid-sem/readiness",
    quitUrl: "https://rec.example/assessments",
    allowedOrigin: "https://rec.example",
  });

describe("the SEB configuration", () => {
  it("is a property list SEB can read", () => {
    const xml = config();
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"');
    expect(xml).toContain('<plist version="1.0">');
    expect(xml.trimEnd().endsWith("</plist>")).toBe(true);
    // Balanced: one dict for the settings, one per URL filter rule.
    expect((xml.match(/<dict>/g) ?? []).length).toBe((xml.match(/<\/dict>/g) ?? []).length);
  });

  it("opens the readiness page, never the sitting", () => {
    // The clock starts on the arena. A configuration that pointed SEB at
    // the attempt URL would drop a candidate into a timed paper the moment
    // the browser launched.
    expect(config()).toContain("<string>https://rec.example/assessments/mid-sem/readiness</string>");
    expect(config()).not.toContain("/attempt");
  });

  it("asks SEB to send the key headers, which is the whole point", () => {
    /**
     * Without `sendBrowserExamKey` the browser sends no
     * `X-SafeExamBrowser-*` headers at all, `verifySeb` sees `absent` and
     * refuses every request — a kiosk paper nobody can sit, from a file
     * that looks perfectly reasonable.
     */
    const xml = config();
    const at = xml.indexOf("sendBrowserExamKey");
    expect(at).toBeGreaterThan(-1);
    expect(xml.slice(at, at + 60)).toContain("<true/>");
  });

  it("lets a candidate quit, and sends them somewhere", () => {
    // A kiosk browser a candidate cannot leave after handing in is a
    // person sitting in front of a locked screen asking for help.
    expect(config()).toContain("allowQuit");
    expect(config()).toContain("<string>https://rec.example/assessments</string>");
  });

  it("allows this college's site and nothing else", () => {
    expect(config()).toContain("<string>https://rec.example/*</string>");
    expect(config()).toContain("URLFilterEnable");
  });

  it("escapes what it writes, so an & in a URL cannot break the file", () => {
    const xml = buildSebConfig({
      startUrl: "https://rec.example/a?x=1&y=2",
      quitUrl: "https://rec.example",
      allowedOrigin: "https://rec.example",
    });
    expect(xml).toContain("x=1&amp;y=2");
    // A bare ampersand makes the plist unparseable, which SEB reports as a
    // configuration it cannot read -- ten minutes before an exam.
    expect(/&(?!amp;|lt;|gt;|quot;|apos;)/.test(xml)).toBe(false);
  });

  it("carries no key and no password, because SEB derives the keys itself", () => {
    // `sendBrowserExamKey` ASKS SEB to send its key; it does not contain
    // one. What must not be here is a key or a password as a value.
    const xml = config();
    expect(xml).not.toContain("<key>configKey</key>");
    expect(xml).not.toContain("<key>browserExamKey</key>");
    expect(xml).not.toContain("<key>hashedQuitPassword</key>");
    expect(xml).not.toContain("<key>hashedAdminPassword</key>");
  });
});

describe("the launch link", () => {
  it("hands an https config to SEB over sebs:", () => {
    expect(sebLaunchUrl("https://rec.example/api/exam/mid-sem/seb-config")).toBe(
      "sebs://rec.example/api/exam/mid-sem/seb-config",
    );
  });

  it("uses seb: for a plain-http deployment, so development works too", () => {
    expect(sebLaunchUrl("http://127.0.0.1:3000/api/exam/x/seb-config")).toBe(
      "seb://127.0.0.1:3000/api/exam/x/seb-config",
    );
  });
});
