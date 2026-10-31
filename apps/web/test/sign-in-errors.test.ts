import { describe, expect, it } from "vitest";
import { referenceId } from "@/lib/errors";
import { SIGN_IN_MESSAGES, rateLimitMessage, signInErrorMessage } from "@/lib/auth/sign-in-errors";

/**
 * /login?error=<code>: only the code chooses the words. Anything a third
 * party puts in a link — an unknown code, a message, a non-numeric wait, a
 * fake reference — is ignored rather than echoed.
 */
describe("signInErrorMessage", () => {
  it("no code, an unknown code or an inherited property name → no message", () => {
    for (const code of [undefined, "", "nope", "Credentials", "toString", "__proto__", "constructor", "hasOwnProperty", "<b>hi</b>"]) {
      expect(signInErrorMessage(code), String(code)).toBeNull();
    }
  });

  it("every known code maps to its own fixed message", () => {
    for (const [code, message] of Object.entries(SIGN_IN_MESSAGES)) expect(signInErrorMessage(code)).toBe(message);
    // One message for every credential failure — it never says which part was wrong.
    expect(signInErrorMessage("credentials")).toBe("Roll number/email or password is incorrect.");
  });

  it("rate-limited: the wait must be 1–4 digits; anything else, zero included, reads as 1 minute", () => {
    expect(signInErrorMessage("rate-limited", "5")).toBe(rateLimitMessage(5));
    expect(signInErrorMessage("rate-limited", "5")).toContain("5 minutes");
    expect(signInErrorMessage("rate-limited", "1")).toContain("1 minute.");
    expect(signInErrorMessage("rate-limited", "9999")).toContain("9999 minutes");
    for (const retry of [undefined, "", "0", "00", "10000", "-3", "1.5", "5m", "abc", " 5"]) {
      expect(signInErrorMessage("rate-limited", retry), String(retry)).toBe(rateLimitMessage(1));
    }
  });

  it("unavailable: a reference is quoted only when it has referenceId()'s exact shape", () => {
    expect(signInErrorMessage("unavailable", undefined, "K7QM2X")).toBe(
      "Something went wrong. Please try again — if it keeps happening, quote reference K7QM2X.",
    );
    for (const ref of [undefined, "", "k7qm2x", "K7QM2", "K7QM2XY", "K7QM20", "K7QM1X", "IOLIOL", "<script>", "K7QM2X\n"]) {
      expect(signInErrorMessage("unavailable", undefined, ref), String(ref)).toBe("Something went wrong. Please try again.");
    }
  });

  it("every referenceId() the route can mint passes the reference check", () => {
    for (let i = 0; i < 500; i++) {
      const ref = referenceId();
      expect(signInErrorMessage("unavailable", undefined, ref)).toContain(`quote reference ${ref}.`);
    }
  });

  it("the extra parameters are ignored for codes that do not use them", () => {
    expect(signInErrorMessage("credentials", "99", "K7QM2X")).toBe(SIGN_IN_MESSAGES.credentials);
  });
});
