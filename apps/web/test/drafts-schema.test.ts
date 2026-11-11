import { describe, expect, it } from "vitest";
import {
  LOCAL_DEBOUNCE_MS,
  MAX_CLOCK_SKEW_MS,
  SERVER_DEBOUNCE_MS,
  legacyDraftKey,
  localDraftKey,
  serverRetryDelayMs,
} from "@/lib/drafts/keys";
import {
  MAX_BEACON_BODY_BYTES,
  MAX_DRAFT_BYTES,
  clampClientTime,
  draftSaveSchema,
  isSameOriginRequest,
  parseBeaconBody,
} from "@/lib/drafts/schema";
import { formatSavedAt, saveStatus } from "@/lib/drafts/status";

const NOW = Date.UTC(2026, 9, 10, 9, 0, 0);
const valid = { problemId: "cmg1abcd0000xyz", language: "cpp20", source: "int main() {}\n", clientUpdatedAt: NOW };

function headers(map: Record<string, string>) {
  const lower = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

describe("draft save schema (action + beacon)", () => {
  it("accepts a well-formed save", () => {
    expect(draftSaveSchema.parse(valid)).toEqual(valid);
  });

  it("accepts an empty draft (the student cleared the editor)", () => {
    expect(draftSaveSchema.safeParse({ ...valid, source: "" }).success).toBe(true);
  });

  it("caps the source at 256 KB of UTF-8, counting bytes not characters", () => {
    expect(MAX_DRAFT_BYTES).toBe(256 * 1024);
    expect(draftSaveSchema.safeParse({ ...valid, source: "a".repeat(MAX_DRAFT_BYTES) }).success).toBe(true);
    expect(draftSaveSchema.safeParse({ ...valid, source: "a".repeat(MAX_DRAFT_BYTES + 1) }).success).toBe(false);
    // "é" is 2 bytes: half as many characters already reach the cap.
    const e = "é".repeat(MAX_DRAFT_BYTES / 2);
    expect(draftSaveSchema.safeParse({ ...valid, source: e }).success).toBe(true);
    expect(draftSaveSchema.safeParse({ ...valid, source: `${e}é` }).success).toBe(false);
  });

  it("refuses NUL (Postgres text cannot hold it)", () => {
    expect(draftSaveSchema.safeParse({ ...valid, source: "a\u0000b" }).success).toBe(false);
  });

  it("refuses unknown languages and malformed problem ids", () => {
    expect(draftSaveSchema.safeParse({ ...valid, language: "brainfuck" }).success).toBe(false);
    for (const problemId of ["", "a b", "x".repeat(65), "../etc", "id;drop"]) {
      expect(draftSaveSchema.safeParse({ ...valid, problemId }).success).toBe(false);
    }
  });

  it("refuses impossible edit times", () => {
    for (const clientUpdatedAt of [0, -1, 1.5, Date.UTC(2019, 11, 31), Date.UTC(2101, 0, 1), Number.NaN, "2026-10-10"]) {
      expect(draftSaveSchema.safeParse({ ...valid, clientUpdatedAt }).success).toBe(false);
    }
  });

  it("drops unknown keys rather than storing them", () => {
    const parsed = draftSaveSchema.parse({ ...valid, userId: "someone-else", role: "SUPER_ADMIN" });
    expect(parsed).not.toHaveProperty("userId");
    expect(parsed).not.toHaveProperty("role");
  });
});

describe("parseBeaconBody", () => {
  it("parses the JSON envelope sendBeacon sends as text/plain", () => {
    const parsed = parseBeaconBody(JSON.stringify(valid));
    expect(parsed.success && parsed.data).toEqual(valid);
  });

  it("fails cleanly (no throw) on garbage", () => {
    for (const body of ["", "not json", "{", "null", "[]", "42", JSON.stringify({ ...valid, source: 7 })]) {
      expect(parseBeaconBody(body).success).toBe(false);
    }
  });

  it("allows the envelope room for JSON escaping of a full-size source", () => {
    const worst = JSON.stringify({ ...valid, source: "\n".repeat(MAX_DRAFT_BYTES) });
    expect(worst.length).toBeLessThan(MAX_BEACON_BODY_BYTES);
    expect(parseBeaconBody(worst).success).toBe(true);
  });
});

describe("clampClientTime", () => {
  it("keeps honest times and clamps a clock running ahead", () => {
    expect(clampClientTime(NOW - 5_000, NOW)).toBe(NOW - 5_000);
    expect(clampClientTime(NOW + 1_000, NOW)).toBe(NOW + 1_000);
    expect(clampClientTime(NOW + 3_600_000, NOW)).toBe(NOW + MAX_CLOCK_SKEW_MS);
  });
});

describe("isSameOriginRequest (beacon CSRF guard)", () => {
  it("uses fetch metadata when the browser sends it", () => {
    expect(isSameOriginRequest(headers({ "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(isSameOriginRequest(headers({ "sec-fetch-site": "cross-site", origin: "https://evil.example" }))).toBe(false);
    expect(isSameOriginRequest(headers({ "sec-fetch-site": "same-site" }))).toBe(false);
    expect(isSameOriginRequest(headers({ "sec-fetch-site": "none" }))).toBe(false);
  });

  it("falls back to Origin vs Host", () => {
    expect(isSameOriginRequest(headers({ origin: "https://code.rec.edu", host: "code.rec.edu" }))).toBe(true);
    expect(isSameOriginRequest(headers({ origin: "http://localhost:3100", host: "localhost:3100" }))).toBe(true);
    expect(isSameOriginRequest(headers({ origin: "https://evil.example", host: "code.rec.edu" }))).toBe(false);
    expect(isSameOriginRequest(headers({ origin: "null", host: "code.rec.edu" }))).toBe(false);
    expect(
      isSameOriginRequest(headers({ origin: "https://code.rec.edu", host: "10.0.0.5:3000", "x-forwarded-host": "code.rec.edu" })),
    ).toBe(true);
  });

  it("allows a request with neither header (not a cross-site browser request)", () => {
    expect(isSameOriginRequest(headers({}))).toBe(true);
  });
});

describe("draft timing and keys", () => {
  it("debounces 400 ms locally and 3 s to the server", () => {
    expect(LOCAL_DEBOUNCE_MS).toBe(400);
    expect(SERVER_DEBOUNCE_MS).toBe(3_000);
  });

  it("backs off failed server saves, capped at a minute", () => {
    expect([1, 2, 3, 4, 5, 6, 50].map(serverRetryDelayMs)).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
    for (const odd of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) expect(serverRetryDelayMs(odd)).toBeGreaterThanOrEqual(5_000);
  });

  it("keys drafts per problem and language", () => {
    expect(localDraftKey("p1", "cpp20")).toBe("draft:p1:cpp20");
    expect(localDraftKey("p1", "py312")).not.toBe(localDraftKey("p1", "cpp20"));
    expect(legacyDraftKey("two-sum", "cpp20")).toBe("recx:draft:two-sum:cpp20");
  });
});

describe("save status wording", () => {
  it("says plainly where the code is", () => {
    expect(saveStatus({ local: "idle", server: "idle" })).toBeNull();
    expect(saveStatus({ local: "saved", server: "idle" })?.label).toBe("Saved on this device");
    expect(saveStatus({ local: "saved", server: "saved" })).toEqual({ label: "Saved to your account", tone: "ok" });
    expect(saveStatus({ local: "unavailable", server: "saved" })?.label).toBe("Saved to your account");
  });

  it("warns when the server copy is behind", () => {
    expect(saveStatus({ local: "saved", server: "failed" })).toEqual({
      label: "Saved on this device · syncing when you are back online",
      tone: "warn",
    });
    expect(saveStatus({ local: "unavailable", server: "failed" })?.label).toBe("Not saved yet · check your connection");
    expect(saveStatus({ local: "saved", server: "unsyncable" })?.tone).toBe("warn");
    expect(saveStatus({ local: "idle", server: "superseded" })?.tone).toBe("warn");
  });

  it("formats save times in campus time", () => {
    const now = Date.UTC(2026, 9, 10, 9, 0, 0); // 14:30 IST
    expect(formatSavedAt(Date.UTC(2026, 9, 10, 8, 0, 0), now)).toMatch(/1:30\s?pm/i);
    expect(formatSavedAt(Date.UTC(2026, 9, 8, 8, 0, 0), now)).toMatch(/^8 Oct, 1:30\s?pm$/i);
    expect(formatSavedAt(null, now)).toBeNull();
    expect(formatSavedAt(0, now)).toBeNull();
  });
});
