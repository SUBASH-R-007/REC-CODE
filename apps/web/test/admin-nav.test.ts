import { describe, expect, it } from "vitest";
import { ADMIN_NAV_GROUPS, SUPER_NAV_GROUP, adminNavFor, allAdminNavItems } from "@/components/admin/admin-nav";
import { implementedRoutes } from "./support/routes";

/**
 * The admin shell never shows a dead link: every href in the admin
 * navigation has a page.tsx. The super-admin console link is shown to
 * SUPER_ADMIN only (hiding it is a convenience — /super guards itself).
 *
 * `/admin/discuss` is still not linked, and Phase 16d closed that as a
 * decision rather than a gap: discussion moderation lives at
 * `/mentor/moderation`, a second queue over the same rows would leave one
 * of them stale, and what was actually missing was the LINK — which the
 * Mentoring group now provides.
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
      // Phase 8d put the inactivity review queue in PEOPLE rather than
      // OPERATIONS: it is a list of students who may need somebody to ask
      // them a question, not a system to administer.
      ["People", ["/admin/students", "/admin/cohorts", "/admin/accommodations", "/admin/inactivity"]],
      // Contests joined Content in Phase 5; the aptitude bank in Phase 7,
      // next to Problems because an author moves between the two.
      [
        "Content",
        [
          "/admin/problems",
          "/admin/aptitude",
          "/admin/sheets",
          "/admin/tracks",
          "/admin/contests",
          "/admin/assessments",
          "/admin/announcements",
        ],
      ],
      ["Insight", ["/admin/reports"]],
      // Phase 16d. Five pages under /mentor, because SPEC §9 gives those
      // powers to TA_MENTOR; an ADMIN holds them as well and had no link
      // to any of them. Moderation first: it is the only one with somebody
      // waiting on the other end.
      [
        "Mentoring",
        [
          "/mentor/moderation",
          "/mentor/doubts",
          "/mentor/written",
          "/mentor/experiences",
          "/mentor/mock-interviews",
        ],
      ],
      ["Operations", ["/admin/judge"]],
    ]);
  });

  it("links the mentor queues for both staff roles", () => {
    // An ADMIN holds MENTOR_CAPABILITIES, so hiding these from them was
    // never access control — just a missing route in.
    for (const role of ["ADMIN", "SUPER_ADMIN"] as const) {
      const hrefs = adminNavFor(role).flatMap((g) => g.items.map((i) => i.href));
      expect(hrefs, role).toContain("/mentor/moderation");
    }
  });

  it("does not link /admin/discuss, and there is no such page (Phase 16d: by decision)", () => {
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
