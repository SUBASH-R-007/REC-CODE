import { describe, expect, it } from "vitest";
import {
  FORGOT_MESSAGES,
  FORGOT_SENT,
  PASSWORD_SET_NOTICE,
  RESET_MESSAGES,
  forgotErrorMessage,
  resetErrorMessage,
} from "@/lib/auth/reset-errors";
import { MAX_FORM_BYTES, readFormBody, seeOther } from "@/lib/http/form-body";

/**
 * The parts of "set a password" that need no database: what the pages are
 * allowed to say, and the shared form reader the three auth routes depend
 * on. The flow itself — one hour, one use, every session ended — is in
 * password-reset.db.test.ts, where it can be exercised against the real
 * trigger.
 */

describe("what the pages may say", () => {
  it("never distinguishes an expired link from a spent or invented one", () => {
    /**
     * The whole point: a visitor with a stolen or guessed link learns
     * nothing from the message, and a visitor with a real expired one is
     * told what to do about it.
     */
    expect(RESET_MESSAGES.invalid).toContain("not valid any more");
    expect(RESET_MESSAGES.invalid).toContain("Ask for a new one");
    const forbidden = [/expired/i, /already used/i, /no such/i, /unknown/i, /does not exist/i, /superseded/i];
    for (const pattern of forbidden) {
      expect(RESET_MESSAGES.invalid, `the message hints at WHICH refusal it was: ${pattern}`).not.toMatch(pattern);
    }
  });

  it("answers a request for a link identically whether or not the account exists", () => {
    // Conditional language, no confirmation. This string is what both the
    // "we sent one" and the "there is nobody to send one to" cases render.
    expect(FORGOT_SENT).toMatch(/^If that/);
    expect(FORGOT_SENT).toContain("one hour");
    for (const pattern of [/we found/i, /no account/i, /not registered/i, /does not exist/i]) {
      expect(FORGOT_SENT).not.toMatch(pattern);
    }
  });

  it("admits only to problems with the form, never with the account", () => {
    expect(Object.keys(FORGOT_MESSAGES).sort()).toEqual([
      "cross-site",
      "identifier-long",
      "identifier-missing",
      "unavailable",
    ]);
  });

  it("maps only codes it knows, so nothing from a link is echoed", () => {
    expect(forgotErrorMessage("identifier-missing")).toBe(FORGOT_MESSAGES["identifier-missing"]);
    expect(forgotErrorMessage(undefined)).toBeNull();
    expect(forgotErrorMessage("<script>alert(1)</script>")).toBeNull();
    expect(forgotErrorMessage("__proto__")).toBeNull();
    expect(resetErrorMessage("invalid")).toBe(RESET_MESSAGES.invalid);
    expect(resetErrorMessage("constructor")).toBeNull();
    expect(resetErrorMessage("nonsense")).toBeNull();
  });

  it("tells somebody who just set a password what to do next", () => {
    expect(PASSWORD_SET_NOTICE).toContain("Sign in");
  });
});

/** A urlencoded request, as a browser form sends one. */
function formRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:3000/api/auth/forgot-password", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body,
  });
}

describe("the shared form reader", () => {
  it("reads a form", async () => {
    const form = await readFormBody(formRequest("identifier=2116231001001&password=hunter2"));
    expect(form?.get("identifier")).toBe("2116231001001");
    expect(form?.get("password")).toBe("hunter2");
  });

  it("refuses anything that is not a form, including JSON", async () => {
    const json = new Request("http://localhost:3000/api/auth/forgot-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"identifier":"x"}',
    });
    expect(await readFormBody(json)).toBeNull();
  });

  it("refuses a body that declares itself too large, without reading it", async () => {
    const request = formRequest("identifier=x", { "content-length": String(MAX_FORM_BYTES + 1) });
    expect(await readFormBody(request)).toBeNull();
  });

  it("refuses a body that grows past the cap while streaming", async () => {
    // No content-length, so the cap has to hold on the stream itself —
    // which is the shape that matters: a chunked body that lies.
    const big = "identifier=" + "a".repeat(MAX_FORM_BYTES + 100);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big));
        controller.close();
      },
    });
    const request = new Request("http://localhost:3000/api/auth/forgot-password", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: stream,
      // @ts-expect-error -- undici needs this for a streaming body
      duplex: "half",
    });
    expect(await readFormBody(request)).toBeNull();
  });

  it("answers an empty body with an empty form rather than null", async () => {
    const request = new Request("http://localhost:3000/api/auth/forgot-password", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const form = await readFormBody(request);
    expect(form?.get("identifier")).toBeNull();
  });

  it("redirects with 303 and no store", () => {
    const response = seeOther("/forgot-password?sent=1");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/forgot-password?sent=1");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
