import type { Role } from "@recx/db";

/**
 * The admin shell's navigation model. Pure data: no JSX, no icons (the
 * server-rendered shell maps `icon` keys to lucide components).
 *
 * Only implemented routes appear here (test/admin-nav.test.ts fails on an
 * href without a page.tsx). Hiding a link is never the access control:
 * every page and action guards itself server-side. /admin/discuss is not
 * built in Phase 4 (discussion arrives with Phase 11), so it is not linked.
 */

export type AdminNavIcon =
  | "overview"
  | "students"
  | "cohorts"
  | "accommodations"
  | "inactivity"
  | "problems"
  | "aptitude"
  | "sheets"
  | "tracks"
  | "contests"
  | "announcements"
  | "reports"
  | "judge"
  | "super";

export interface AdminNavItem {
  href: string;
  label: string;
  icon: AdminNavIcon;
  /** "prefix" also marks nested routes (/admin/students/abc → Students). */
  match: "exact" | "prefix";
}

export interface AdminNavGroup {
  id: "overview" | "people" | "content" | "insight" | "operations" | "super";
  label: string;
  items: readonly AdminNavItem[];
}

const item = (href: string, label: string, icon: AdminNavIcon, match: AdminNavItem["match"] = "prefix"): AdminNavItem =>
  Object.freeze({ href, label, icon, match });

export const ADMIN_NAV_GROUPS: readonly AdminNavGroup[] = Object.freeze([
  { id: "overview", label: "Overview", items: Object.freeze([item("/admin", "Overview", "overview", "exact")]) },
  {
    id: "people",
    label: "People",
    items: Object.freeze([
      item("/admin/students", "Students", "students"),
      item("/admin/cohorts", "Cohorts", "cohorts"),
      item("/admin/accommodations", "Accommodations", "accommodations"),
      // Phase 8d. In PEOPLE rather than OPERATIONS on purpose: the queue is
      // a list of students who may need somebody to ask them a question, not
      // a system to administer.
      item("/admin/inactivity", "Inactivity", "inactivity"),
    ]),
  },
  {
    id: "content",
    label: "Content",
    items: Object.freeze([
      item("/admin/problems", "Problems", "problems"),
      // Phase 7: the aptitude bank is content like any other, and it sits
      // next to Problems because an author moves between the two.
      item("/admin/aptitude", "Aptitude", "aptitude"),
      item("/admin/sheets", "Sheets", "sheets"),
      item("/admin/tracks", "Tracks", "tracks"),
      item("/admin/contests", "Contests", "contests"),
      item("/admin/announcements", "Announcements", "announcements"),
    ]),
  },
  { id: "insight", label: "Insight", items: Object.freeze([item("/admin/reports", "Reports", "reports")]) },
  { id: "operations", label: "Operations", items: Object.freeze([item("/admin/judge", "Judge", "judge")]) },
]);

/** The SUPER_ADMIN-only group: a way into the /super console. */
export const SUPER_NAV_GROUP: AdminNavGroup = Object.freeze({
  id: "super",
  label: "Super-admin",
  items: Object.freeze([item("/super", "Super-admin console", "super")]),
});

/** The groups shown to a role (the console link only for SUPER_ADMIN). */
export function adminNavFor(role: Role): AdminNavGroup[] {
  return role === "SUPER_ADMIN" ? [...ADMIN_NAV_GROUPS, SUPER_NAV_GROUP] : [...ADMIN_NAV_GROUPS];
}

/** Every distinct href the admin shell can link to (any role). */
export function allAdminNavItems(): AdminNavItem[] {
  return [...ADMIN_NAV_GROUPS, SUPER_NAV_GROUP].flatMap((g) => g.items);
}
