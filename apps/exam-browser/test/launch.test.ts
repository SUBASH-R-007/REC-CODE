import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { examBrowserLaunchUrl, examBrowserSigningInput, RECX_SIGNATURE_HEADER, RECX_SITTING_HEADER } from "@recx/shared/exam-browser";
import { EXCHANGE_PATH, exchange, launchUrlIn } from "../src/launch";
import { attestationHeaders, heldSitting, holdSitting, releaseSitting, type Sitting } from "../src/sitting";

/**
 * Starting a sitting, and signing what follows (Phase 14c).
 *
 * `fetch` is injected, so the whole launch is exercised here without a
 * network, a server or an Electron runtime.
 */

const ALLOWED = ["https://code.rec.edu.in"];
const TOKEN = "t".repeat(48);

const okBody = {
  protocol: 1,
  sittingId: "sit_1",
  sittingKey: "k".repeat(64),
  assessmentId: "asm_1",
  assessmentSlug: "mid-term-ds",
};

const fakeFetch = (body: unknown, status = 200) =>
  // Typed with fetch's own parameters so the assertions below can read
  // what the application actually sent, not just that it sent something.
  vi.fn(
    async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );

describe("finding the launch URL", () => {
  it("picks it out of an argv", () => {
    const url = examBrowserLaunchUrl({ origin: ALLOWED[0]!, token: TOKEN });
    expect(launchUrlIn(["recx-exam.exe", "--enable-logging", url])).toBe(url);
  });

  it("is null when the application was opened on its own", () => {
    expect(launchUrlIn(["recx-exam.exe"])).toBeNull();
  });
});

describe("exchanging the launch token", () => {
  it("posts the token to the exchange and returns the sitting", async () => {
    const fetchImpl = fakeFetch(okBody);
    const outcome = await exchange({
      launchUrl: examBrowserLaunchUrl({ origin: ALLOWED[0]!, token: TOKEN }),
      allowedOrigins: ALLOWED,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(outcome).toEqual({
      ok: true,
      sitting: {
        sittingId: "sit_1",
        sittingKey: "k".repeat(64),
        origin: ALLOWED[0],
        assessmentId: "asm_1",
        assessmentSlug: "mid-term-ds",
      },
    });
    expect(fetchImpl.mock.calls[0]![0]).toBe(`${ALLOWED[0]}${EXCHANGE_PATH}`);
  });

  it("sends no cookies and follows no redirect", async () => {
    /**
     * Both matter. The application has no cookies and a launch must never
     * start depending on one; and a redirect followed out of the exchange
     * would be a way to make it POST a live token somewhere else.
     */
    const fetchImpl = fakeFetch(okBody);
    await exchange({
      launchUrl: examBrowserLaunchUrl({ origin: ALLOWED[0]!, token: TOKEN }),
      allowedOrigins: ALLOWED,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const init = fetchImpl.mock.calls[0]![1]!;
    expect(init.credentials).toBe("omit");
    expect(init.redirect).toBe("error");
  });

  it("refuses an origin this build was not shipped to talk to, without asking it anything", async () => {
    /**
     * The attack the allowlist exists for, end to end: a page opens the
     * custom scheme pointing at its own server. Nothing must be sent
     * there — not the token, not even a connection.
     */
    const fetchImpl = fakeFetch(okBody);
    const outcome = await exchange({
      launchUrl: examBrowserLaunchUrl({ origin: "https://code.rec.edu.in.evil.test", token: TOKEN }),
      allowedOrigins: ALLOWED,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(outcome).toEqual({ ok: false, reason: "bad_origin" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("passes the server's own sentence through when it refuses", async () => {
    const outcome = await exchange({
      launchUrl: examBrowserLaunchUrl({ origin: ALLOWED[0]!, token: TOKEN }),
      allowedOrigins: ALLOWED,
      fetchImpl: fakeFetch({ error: "That launch has already been used." }, 409) as unknown as typeof fetch,
    });
    expect(outcome).toEqual({ ok: false, reason: "That launch has already been used." });
  });

  it("refuses a reply missing any field rather than half-starting a sitting", async () => {
    for (const missing of ["sittingId", "sittingKey", "assessmentId", "assessmentSlug"]) {
      const body: Record<string, unknown> = { ...okBody };
      delete body[missing];
      const outcome = await exchange({
        launchUrl: examBrowserLaunchUrl({ origin: ALLOWED[0]!, token: TOKEN }),
        allowedOrigins: ALLOWED,
        fetchImpl: fakeFetch(body) as unknown as typeof fetch,
      });
      expect(outcome, missing).toEqual({ ok: false, reason: "exchange_malformed" });
    }
  });

  it("never puts the token in the reason it reports", async () => {
    const outcome = await exchange({
      launchUrl: examBrowserLaunchUrl({ origin: ALLOWED[0]!, token: TOKEN }),
      allowedOrigins: ALLOWED,
      fetchImpl: (() => {
        throw new Error(`connect failed for token ${TOKEN}`);
      }) as unknown as typeof fetch,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).not.toContain(TOKEN);
  });
});

describe("the key this copy is holding", () => {
  const sitting: Sitting = {
    sittingId: "sit_1",
    sittingKey: "k".repeat(64),
    origin: ALLOWED[0]!,
    assessmentId: "asm_1",
    assessmentSlug: "mid-term-ds",
  };

  it("is forgotten when the sitting is released", () => {
    holdSitting(sitting);
    expect(heldSitting()).toEqual(sitting);
    releaseSitting();
    expect(heldSitting()).toBeNull();
  });
});

describe("the headers it signs with", () => {
  const sitting: Sitting = {
    sittingId: "sit_1",
    sittingKey: "k".repeat(64),
    origin: ALLOWED[0]!,
    assessmentId: "asm_1",
    assessmentSlug: "mid-term-ds",
  };
  const url = `${ALLOWED[0]}/api/exam/att_1/hb`;

  it("produces exactly what the shared verifier recomputes", () => {
    const headers = attestationHeaders({ method: "POST", url, sitting, now: 1_000, nonce: "n-1" });
    const expected = createHmac("sha256", sitting.sittingKey)
      .update(examBrowserSigningInput({ method: "POST", url, nonce: "n-1", timestamp: 1_000, sittingId: "sit_1" }))
      .digest("hex");
    expect(headers[RECX_SIGNATURE_HEADER]).toBe(expected);
    expect(headers[RECX_SITTING_HEADER]).toBe("sit_1");
  });

  it("uses a fresh nonce every time, which is what makes one capture worth one request", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      seen.add(attestationHeaders({ method: "GET", url, sitting })["x-recx-exam-nonce"]!);
    }
    expect(seen.size).toBe(200);
  });

  it("never puts the key in a header", () => {
    const headers = attestationHeaders({ method: "GET", url, sitting });
    for (const value of Object.values(headers)) expect(value).not.toContain(sitting.sittingKey);
  });
});
