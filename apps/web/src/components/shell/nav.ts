/**
 * The student shell's navigation model. Pure data + one matcher: no JSX, no
 * icons (the server-rendered sidebar maps `icon` keys to lucide components,
 * so no icon code ships to the browser for navigation).
 *
 * Only implemented routes appear here. COMPETE gains Contests in Phase 5 and
 * an ASSESS group (Assessments) arrives in Phases 6-7: add the entry in the
 * same change that adds the page. A group with no items is not rendered, and
 * test/shell-nav.test.ts fails if any href here has no page.tsx — the shell
 * never shows a dead link.
 */

export type NavIconKey =
  | "dashboard"
  | "problems"
  | "sheets"
  | "learn"
  | "revision"
  | "contests"
  | "aptitude"
  | "placement"
  | "interviews"
  | "mock"
  | "written"
  | "leaderboard"
  | "profile"
  | "bookmarks"
  | "notes"
  | "notifications"
  | "leave"
  | "help"
  | "judge"
  | "accessibility";

export interface ShellNavItem {
  href: string;
  label: string;
  icon: NavIconKey;
  /** "prefix" also marks nested routes (/problems/two-sum → Problems). */
  match: "exact" | "prefix";
  /** One line for the command palette. */
  description: string;
}

export interface ShellNavGroup {
  id: "practice" | "compete" | "assess" | "me";
  label: string;
  items: readonly ShellNavItem[];
}

const item = (
  href: string,
  label: string,
  icon: NavIconKey,
  description: string,
  match: ShellNavItem["match"] = "prefix",
): ShellNavItem => Object.freeze({ href, label, icon, match, description });

export const DASHBOARD_ITEM = item("/dashboard", "Dashboard", "dashboard", "Your next step, streak and weekly goal", "exact");

const PROBLEMS = item("/problems", "Problems", "problems", "Browse and solve practice problems");
const SHEETS = item("/sheets", "Sheets", "sheets", "Curated problem sheets for placements");
const LEARN = item("/learn", "Learn", "learn", "Guided topic tracks");
// Phase 12c. In PRACTICE rather than ME, because revising is practice — and
// a student who has to go looking for it under their own profile will not.
const REVISION = item("/revision", "Revision", "revision", "Problems you solved, coming back on a spaced schedule");
const CONTESTS = item("/contests", "Contests", "contests", "Timed rounds, standings and your rating");
const LEADERBOARD = item("/leaderboard", "Leaderboard", "leaderboard", "Weekly, monthly and all-time XP rankings");
const PROFILE = item("/profile", "Profile", "profile", "Your progress, badges and settings");
const BOOKMARKS = item("/bookmarks", "Bookmarks", "bookmarks", "Problems you saved for later");
const NOTES = item("/notes", "Notes", "notes", "Your private Markdown notes");
const NOTIFICATIONS = item("/notifications", "Notifications", "notifications", "Badges, streaks and announcements");
const LEAVE = item(
  "/account/leave",
  "Excused days",
  "leave",
  "Tell us about days you were ill or away, so they are not counted as time you did not practise",
);

export const NAV_GROUPS: readonly ShellNavGroup[] = Object.freeze([
  { id: "practice", label: "Practice", items: Object.freeze([PROBLEMS, REVISION, SHEETS, LEARN]) },
  { id: "compete", label: "Compete", items: Object.freeze([CONTESTS, LEADERBOARD]) },
  // ASSESS: Phase 7's aptitude surface. The group was reserved empty for
  // Phases 6-7 and this is its first entry — Phase 6's assessments are
  // reached from a sitting link rather than from the nav, because a
  // proctored exam is something a student is sent to at a time, not
  // something they browse to.
  {
    id: "assess",
    label: "Assess",
    items: Object.freeze([
      item(
        "/aptitude",
        "Aptitude",
        "aptitude",
        "Quantitative, logical and verbal practice, and full mocks with worked explanations",
      ),
      // Phase 9c. In ASSESS rather than ME, because readiness is a measure
      // of preparation and belongs beside the things that measure it — and
      // because a student looking for "am I ready" does not look under
      // their own profile for it.
      // Phase 12h. First in ASSESS: a mock is the one thing on this page a
      // student does WITH somebody, and a booking has a time on it.
      item(
        "/mock-interviews",
        "Mock interviews",
        "mock",
        "Book half an hour with a TA, and read what they wrote afterwards",
      ),
      // Phase 12e. Beside Readiness, because both answer "what should I do
      // before the drive" — and this one answers it with what companies
      // actually asked rather than with a score.
      item(
        "/interviews",
        "Interviews",
        "interviews",
        "What companies actually asked, reported by students here",
      ),
      // Phase 12i. After Interviews and before Readiness: the archive says
      // which rounds companies run, and this is where a student practises
      // the one that has no program in it.
      item(
        "/written",
        "Written",
        "written",
        "Design and written questions, marked by a TA against a published rubric",
      ),
      item(
        "/placement",
        "Readiness",
        "placement",
        "How much of the placement preparation you have covered, and the most useful thing to do next",
      ),
    ]),
  },
  { id: "me", label: "Me", items: Object.freeze([PROFILE, BOOKMARKS, NOTES, NOTIFICATIONS, LEAVE]) },
]);

/** The five-item bottom bar below 1024 px. */
export const MOBILE_NAV: readonly ShellNavItem[] = Object.freeze([DASHBOARD_ITEM, PROBLEMS, SHEETS, LEADERBOARD, PROFILE]);

/** Footer links of the sidebar (and palette commands). */
export const SECONDARY_NAV: readonly ShellNavItem[] = Object.freeze([
  item("/help", "How judging works", "help", "Verdicts, compare modes, time limits and hints"),
  item("/judge", "Judge specifications", "judge", "Compiler versions, flags, limits and verdict rules"),
  item("/accessibility", "Accessibility", "accessibility", "Our accessibility statement and how to report a barrier"),
]);

/** Groups that have at least one item — the only ones the shell renders. */
export function visibleGroups(groups: readonly ShellNavGroup[] = NAV_GROUPS): ShellNavGroup[] {
  return groups.filter((group) => group.items.length > 0);
}

/** Every distinct navigation destination (sidebar, bottom bar, footer). */
export function allNavItems(): ShellNavItem[] {
  const seen = new Map<string, ShellNavItem>();
  for (const entry of [DASHBOARD_ITEM, ...NAV_GROUPS.flatMap((g) => g.items), ...MOBILE_NAV, ...SECONDARY_NAV]) {
    if (!seen.has(entry.href)) seen.set(entry.href, entry);
  }
  return [...seen.values()];
}

/** Does `pathname` belong to this nav entry (for aria-current)? */
export function isNavActive(pathname: string | null, entry: Pick<ShellNavItem, "href" | "match">): boolean {
  if (!pathname) return false;
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  if (path === entry.href) return true;
  return entry.match === "prefix" && path.startsWith(`${entry.href}/`);
}
