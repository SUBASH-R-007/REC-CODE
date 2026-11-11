import { describe, expect, it } from "vitest";
import { parseCursor, safeNotificationHref } from "@/app/(student)/notifications/model";

describe("safeNotificationHref", () => {
  it.each([
    ["/problems/two-sum", "/problems/two-sum"],
    ["/leaderboard?period=week", "/leaderboard?period=week"],
    ["/profile#badges", "/profile#badges"],
    ["/notes/../dashboard", "/dashboard"], // resolved, still same-origin
  ])("keeps the same-origin path %s", (link, expected) => {
    expect(safeNotificationHref(link)).toBe(expected);
  });

  it.each([
    null,
    undefined,
    "",
    "https://evil.example/x",
    "//evil.example/x",
    "/\\evil.example",
    "\\\\evil.example",
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,hi",
    "problems/two-sum",
    "/problems\u0000/x",
    "/problems\n/x",
    "/‮evil",
    `/${"x".repeat(600)}`,
  ])("refuses %j", (link) => {
    expect(safeNotificationHref(link)).toBeNull();
  });
});

describe("parseCursor", () => {
  it("accepts an id-shaped value and ignores everything else", () => {
    expect(parseCursor("clx123abc")).toBe("clx123abc");
    expect(parseCursor(["clx1", "clx2"])).toBe("clx1");
    expect(parseCursor(undefined)).toBeNull();
    expect(parseCursor("")).toBeNull();
    expect(parseCursor("bad id")).toBeNull();
    expect(parseCursor("x".repeat(65))).toBeNull();
    expect(parseCursor("'; drop table")).toBeNull();
  });
});
