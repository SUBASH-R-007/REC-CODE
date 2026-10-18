import { describe, expect, it } from "vitest";
import { ADMIN_NAV_GROUPS, SUPER_NAV_GROUP, adminNavFor, allAdminNavItems } from "@/components/admin/admin-nav";
import { implementedRoutes } from "./support/routes";

/**
 * The admin shell never shows a dead link: every href in the admin
 * navigation has a page.tsx. /admin/discuss is not built in Phase 4, so it is
 * not linked; the super-admin console link is shown to SUPER_ADMIN only
 * (hiding it is a convenience — /super guards itself).
 */

describe("admin navigation", () => {
  const routes = implementedRoutes();

  it("discovers the admin routes (sanity)", () => {
    expect(routes.has("/admin")).toBe(true);
    expect(routes.has("/admin/students/[id]")).toBe(true);
  });

  it.each(allAdminNavItems().map((i) => [i.href, i.label]))("%s (%s) has a page.tsx", (href) => {
    expect(routes.has(href), `${href} has no page.tsx — the admin shell must not link to it`).toBe(true);
  });

  it("groups the sections as designed", () => {
    expect(ADMIN_NAV_GROUPS.map((g) => [g.label, g.items.map((i) => i.href)])).toEqual([
      ["Overview", ["/admin"]],
      ["People", ["/admin/students", "/admin/cohorts", "/admin/accommodations"]],
      // Contests joined Content in Phase 5.
      [
        "Content",
        ["/admin/problems", "/admin/sheets", "/admin/tracks", "/admin/contests", "/admin/announcements"],
      ],
      ["Insight", ["/admin/reports"]],
      ["Operations", ["/admin/judge"]],
    ]);
  });

  it("does not link /admin/discuss (Phase 11)", () => {
    expect(allAdminNavItems().some((i) => i.href.startsWith("/admin/discuss"))).toBe(false);
    expect(routes.has("/admin/discuss")).toBe(false);
  });

  it("shows the super-admin console only to SUPER_ADMIN", () => {
    const hrefs = (role: "ADMIN" | "SUPER_ADMIN") => adminNavFor(role).flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs("SUPER_ADMIN")).toContain("/super");
    expect(hrefs("ADMIN")).not.toContain("/super");
    expect(SUPER_NAV_GROUP.items.map((i) => i.label)).toEqual(["Super-admin console"]);
  });

  it("marks only the overview as an exact match", () => {
    const exact = allAdminNavItems().filter((i) => i.match === "exact").map((i) => i.href);
    expect(exact).toEqual(["/admin"]);
  });
});
