import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DASHBOARD_ITEM,
  MOBILE_NAV,
  NAV_GROUPS,
  SECONDARY_NAV,
  allNavItems,
  isNavActive,
  visibleGroups,
} from "@/components/shell/nav";
import { MAX_UNREAD_SHOWN, unreadBadge, unreadLabel } from "@/components/shell/unread";

/**
 * The shell never shows a dead link: every navigation destination must be a
 * route with a page.tsx under src/app (route groups like "(student)" do not
 * appear in URLs).
 */

const APP_DIR = path.resolve(__dirname, "../src/app");

/** Static routes ("/problems", "/notes/new") that have a page file. */
function implementedRoutes(): Set<string> {
  const routes = new Set<string>();
  const walk = (dir: string, segments: string[]) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name.startsWith("_") || name.startsWith("@")) continue; // private folders, parallel slots
        const isGroup = name.startsWith("(") && name.endsWith(")");
        walk(full, isGroup ? segments : [...segments, name]);
      } else if (/^page\.(tsx|ts|jsx|js|mdx)$/.test(name)) {
        routes.add(`/${segments.join("/")}`);
      }
    }
  };
  walk(APP_DIR, []);
  return routes;
}

describe("shell navigation model", () => {
  const routes = implementedRoutes();

  it("discovers the app's routes (sanity)", () => {
    expect(existsSync(APP_DIR)).toBe(true);
    expect(routes.has("/problems")).toBe(true);
    expect(routes.has("/dashboard")).toBe(true);
  });

  it.each(allNavItems().map((item) => [item.href, item.label]))(
    "%s (%s) is an implemented route",
    (href) => {
      expect(routes.has(href), `${href} has no page.tsx — the shell must not link to it yet`).toBe(true);
    },
  );

  it("groups PRACTICE, COMPETE and ME as specified, in order", () => {
    const shown = visibleGroups().map((g) => [g.label, g.items.map((i) => i.href)]);
    expect(shown).toEqual([
      ["Practice", ["/problems", "/sheets", "/learn"]],
      ["Compete", ["/leaderboard"]],
      ["Me", ["/profile", "/bookmarks", "/notes", "/notifications"]],
    ]);
  });

  it("does not render a group that has no implemented entries", () => {
    const assess = NAV_GROUPS.find((g) => g.id === "assess");
    expect(assess?.items).toHaveLength(0);
    expect(visibleGroups().some((g) => g.id === "assess")).toBe(false);
    expect(visibleGroups([{ id: "compete", label: "Compete", items: [] }])).toEqual([]);
  });

  it("does not link contests or assessments before their phases", () => {
    for (const item of allNavItems()) {
      expect(item.href.startsWith("/contests")).toBe(false);
      expect(item.href.startsWith("/assessments")).toBe(false);
    }
  });

  it("has a five-item bottom bar: Dashboard, Problems, Sheets, Leaderboard, Profile", () => {
    expect(MOBILE_NAV.map((i) => i.label)).toEqual(["Dashboard", "Problems", "Sheets", "Leaderboard", "Profile"]);
    // Every bottom-bar destination is also reachable from the sidebar.
    const sidebar = new Set([DASHBOARD_ITEM.href, ...NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href))]);
    for (const item of MOBILE_NAV) expect(sidebar.has(item.href)).toBe(true);
  });

  it("lists every destination once, with a label and a palette description", () => {
    const hrefs = allNavItems().map((i) => i.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const item of allNavItems()) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.description.length).toBeGreaterThan(0);
      expect(item.href.startsWith("/")).toBe(true);
    }
    expect(SECONDARY_NAV.map((i) => i.href)).toEqual(["/help", "/judge", "/accessibility"]);
  });

  it("is frozen (no accidental runtime edits)", () => {
    expect(Object.isFrozen(NAV_GROUPS)).toBe(true);
    expect(Object.isFrozen(MOBILE_NAV)).toBe(true);
    expect(Object.isFrozen(DASHBOARD_ITEM)).toBe(true);
  });
});

describe("isNavActive", () => {
  const problems = { href: "/problems", match: "prefix" as const };
  const dashboard = { href: "/dashboard", match: "exact" as const };

  it.each([
    ["/problems", problems, true],
    ["/problems/", problems, true],
    ["/problems/two-sum", problems, true],
    ["/problemset", problems, false],
    ["/", problems, false],
    [null, problems, false],
    ["/dashboard", dashboard, true],
    ["/dashboard/x", dashboard, false],
  ] as const)("%s → %s", (pathname, item, expected) => {
    expect(isNavActive(pathname, item)).toBe(expected);
  });
});

describe("notification bell label", () => {
  it("speaks the count, capped", () => {
    expect(unreadLabel(0)).toBe("Notifications");
    expect(unreadLabel(3)).toBe("Notifications, 3 unread");
    expect(unreadLabel(MAX_UNREAD_SHOWN + 1)).toBe(`Notifications, more than ${MAX_UNREAD_SHOWN} unread`);
    expect(unreadBadge(7)).toBe("7");
    expect(unreadBadge(250)).toBe("99+");
  });
});
