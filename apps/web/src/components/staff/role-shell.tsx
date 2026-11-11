import type { Role, User } from "@recx/db";
import { ShieldCheck } from "lucide-react";
import { NavLink } from "@/components/shell/nav-link";
import { UserMenu } from "@/components/shell/user-menu";
import { Wordmark } from "@/components/shell/wordmark";
import { ThemeToggle } from "@/components/theme/theme-toggle";

/**
 * Chrome for the two small staff trees Phase 9 adds: the placement cell and
 * the mentor's own pages.
 *
 * Deliberately not `AdminShell`. That shell renders `adminNavFor(role)`,
 * which is the admin sections — showing them to a placement officer would
 * advertise a dozen pages their guard refuses, and a nav full of links that
 * bounce is worse than no nav. This one takes the links it should show.
 *
 * Hiding a link is never the access control: the layout has already run the
 * role guard and every page runs it again.
 */

const ROLE_LABELS: Partial<Record<Role, string>> = {
  TA_MENTOR: "TA / mentor",
  PLACEMENT_OFFICER: "Placement cell",
  ADMIN: "Administrator",
  SUPER_ADMIN: "Super admin",
};

const LINK = "flex min-h-10 items-center rounded-xl px-3 py-2 text-sm font-medium transition-colors";
// Active: a filled pill AND a heavier label — never colour alone.
const ACTIVE = "bg-primary-subtle font-semibold text-text";
const INACTIVE = "text-text-secondary hover:bg-primary-subtle hover:text-text";

export interface RoleNavItem {
  readonly href: string;
  readonly label: string;
  readonly match: "exact" | "prefix";
}

export function RoleShell({
  user,
  area,
  home,
  nav,
  children,
}: {
  user: User;
  /** The badge beside the wordmark: what tree this is. */
  area: string;
  home: string;
  nav: readonly RoleNavItem[];
  children: React.ReactNode;
}) {
  return (
    <div className="app-backdrop min-h-dvh">
      <header className="glass sticky top-0 z-20 border-b border-border">
        <div className="flex h-14 items-center gap-2 px-4 sm:gap-3 sm:px-6">
          <Wordmark href={home} />
          <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-primary/20 bg-primary-subtle px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-primary">
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
            {area}
          </span>
          <div className="flex-1" />
          <ThemeToggle compact />
          <UserMenu
            firstName={user.firstName}
            lastName={user.lastName}
            email={user.email}
            collegeId={user.collegeId}
            roleLabel={ROLE_LABELS[user.role] ?? "Staff"}
          />
        </div>
        {nav.length > 1 ? (
          <nav aria-label={area} className="border-t border-border px-2 sm:px-4">
            <ul className="flex flex-wrap gap-1 py-1.5">
              {nav.map((entry) => (
                <li key={entry.href}>
                  <NavLink
                    href={entry.href}
                    match={entry.match}
                    className={LINK}
                    activeClassName={ACTIVE}
                    inactiveClassName={INACTIVE}
                  >
                    {entry.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
      </header>

      <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-6xl px-4 pb-16 pt-6 outline-none sm:px-6">
        {children}
      </main>
    </div>
  );
}
