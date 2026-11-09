import type { Role } from "@recx/db";

/**
 * The admin shell's navigation model. Pure data: no JSX, no icons (the
 * server-rendered shell maps `icon` keys to lucide components).
 *
 * Only implemented routes appear here (test/admin-nav.test.ts fails on an
 * href without a page.tsx). Hiding a link is never the access control:
 * every page and action guards itself server-side.
 *
 * **`/admin/discuss` is not built, and will not be (Phase 16d).** The Phase
 * 4 note here said discussion arrives with Phase 11 and the route is
 * therefore unlinked. Discussion arrived in 12d — with its moderation queue
 * at `/mentor/moderation`, because `TA_MENTOR` is the role SPEC §9 gives
 * those powers to. An `/admin/discuss` built now would be a SECOND queue
 * over the same rows, and the predictable outcome of two queues is that one
 * of them is the stale one somebody is not reading.
 *
 * What was actually missing was a way IN. An ADMIN holds every mentor
 * capability and had no link to any of these five pages from the admin
 * shell, so a report a student filed landed in a queue only a TA_MENTOR
 * would think to visit. That is what the Mentoring group below fixes.
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
  | "assessments"
  | "announcements"
  | "reports"
  | "judge"
  | "moderation"
  | "doubts"
  | "written"
  | "experiences"
  | "mockInterviews"
  | "super";

export interface AdminNavItem {
  href: string;
  label: string;
  icon: AdminNavIcon;
  /** "prefix" also marks nested routes (/admin/students/abc → Students). */
  match: "exact" | "prefix";
}

export interface AdminNavGroup {
  id: "overview" | "people" | "content" | "insight" | "mentoring" | "operations" | "super";
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
      // Phase 12a. Next to Contests because they are the same act seen from
      // two sides — a paper a cohort sits — and different in the one way
      // that matters: an assessment is always proctored.
      item("/admin/assessments", "Assessments", "assessments"),
      item("/admin/announcements", "Announcements", "announcements"),
    ]),
  },
  { id: "insight", label: "Insight", items: Object.freeze([item("/admin/reports", "Reports", "reports")]) },
  {
    /**
     * Phase 16d. These five pages live under /mentor because SPEC §9 gives
     * a TA_MENTOR exactly these powers; an ADMIN and a SUPER_ADMIN hold
     * them too (MENTOR_CAPABILITIES) and until now had no link to any of
     * them. Moderation is first because it is the only one with somebody
     * waiting on the other end of it.
     */
    id: "mentoring",
    label: "Mentoring",
    items: Object.freeze([
      item("/mentor/moderation", "Moderation", "moderation"),
      item("/mentor/doubts", "Doubts", "doubts"),
      item("/mentor/written", "Written answers", "written"),
      item("/mentor/experiences", "Interview archive", "experiences"),
      item("/mentor/mock-interviews", "Mock interviews", "mockInterviews"),
    ]),
  },
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
