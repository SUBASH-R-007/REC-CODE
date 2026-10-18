import type { Role, User } from "@recx/db";
import {
  Accessibility,
  ChartColumnBig,
  ChevronDown,
  Cpu,
  Eye,
  GraduationCap,
  LayoutDashboard,
  ListChecks,
  Megaphone,
  Menu,
  ShieldAlert,
  ShieldCheck,
  SquareCode,
  Swords,
  UsersRound,
  Layers,
  type LucideIcon,
} from "lucide-react";
import { NavLink } from "@/components/shell/nav-link";
import { UserMenu } from "@/components/shell/user-menu";
import { Wordmark } from "@/components/shell/wordmark";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { adminNavFor, type AdminNavGroup, type AdminNavIcon } from "@/components/admin/admin-nav";

const ROLE_LABELS: Partial<Record<Role, string>> = {
  ADMIN: "Administrator",
  SUPER_ADMIN: "Super admin",
};

const ICONS: Readonly<Record<AdminNavIcon, LucideIcon>> = {
  overview: LayoutDashboard,
  students: UsersRound,
  cohorts: Layers,
  accommodations: Accessibility,
  problems: SquareCode,
  sheets: ListChecks,
  tracks: GraduationCap,
  contests: Swords,
  announcements: Megaphone,
  reports: ChartColumnBig,
  judge: Cpu,
  super: ShieldAlert,
};

const LINK = "flex min-h-10 items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors";
// Active: a filled pill, a bar on the left edge and a heavier label — never colour alone.
const ACTIVE =
  "relative bg-primary-subtle font-semibold text-text before:absolute before:inset-y-2 before:left-0 before:w-1 before:rounded-r-full before:bg-primary";
const INACTIVE = "text-text-secondary hover:bg-primary-subtle hover:text-text";

/** The grouped admin navigation; NavLink is the only client code (aria-current). */
function AdminNav({ groups, idPrefix }: { groups: readonly AdminNavGroup[]; idPrefix: string }) {
  return (
    <nav aria-label="Admin" className="flex flex-col gap-4">
      {groups.map((group) => {
        const labelId = `${idPrefix}-admin-nav-${group.id}`;
        return (
          <div key={group.id}>
            <p id={labelId} className="px-3 pb-1.5 text-[0.68rem] font-semibold uppercase tracking-wider text-muted">
              {group.label}
            </p>
            <ul aria-labelledby={labelId} className="flex flex-col gap-0.5">
              {group.items.map((entry) => {
                const Icon = ICONS[entry.icon];
                return (
                  <li key={entry.href}>
                    <NavLink href={entry.href} match={entry.match} className={LINK} activeClassName={ACTIVE} inactiveClassName={INACTIVE}>
                      <Icon className="h-[1.1rem] w-[1.1rem] shrink-0" aria-hidden />
                      {entry.label}
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

/** Whose students this admin can see. Text, not colour, carries it. */
function ScopeChip({ label, className }: { label: string; className?: string }) {
  return (
    <span
      className={`inline-flex min-w-0 items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-0.5 text-xs text-text-secondary ${className ?? ""}`}
      title={`Students you can see: ${label}`}
    >
      <Eye className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="sr-only">Your student scope: </span>
      <span className="truncate">{label}</span>
    </span>
  );
}

/**
 * Admin chrome: a sidebar at 1024 px and wider; below that a menu that is a
 * plain <details> (works without JavaScript). The top bar shows the
 * "Admin" label, the viewer's student scope and the account menu. The
 * layout has already run the role guard and loaded the scope; this only
 * renders. Hiding a link is never the access control.
 */
export function AdminShell({
  user,
  scopeLabel,
  children,
}: {
  user: User;
  scopeLabel: string;
  children: React.ReactNode;
}) {
  const groups = adminNavFor(user.role);
  return (
    <div className="app-backdrop min-h-dvh">
      <aside
        aria-label="Admin sidebar"
        className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-border bg-surface/80 backdrop-blur-sm lg:flex"
      >
        <div className="flex h-14 shrink-0 items-center px-4">
          <Wordmark href="/admin" />
        </div>
        <div className="scroll-thin flex-1 overflow-y-auto px-3 pb-4 pt-2" tabIndex={0} aria-label="Admin sections">
          <AdminNav groups={groups} idPrefix="side" />
        </div>
      </aside>

      <header className="glass sticky top-0 z-20 border-b border-border lg:pl-60">
        <div className="flex h-14 items-center gap-2 px-4 sm:gap-3 sm:px-6">
          <div className="lg:hidden">
            <Wordmark href="/admin" />
          </div>
          <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-primary/20 bg-primary-subtle px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-primary">
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
            Admin
          </span>
          <ScopeChip label={scopeLabel} className="hidden max-w-[16rem] sm:inline-flex" />
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
        <details className="group border-t border-border lg:hidden">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 text-sm font-medium text-text sm:px-6 [&::-webkit-details-marker]:hidden">
            <Menu className="h-4 w-4" aria-hidden />
            Admin menu
            <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" aria-hidden />
            <ScopeChip label={scopeLabel} className="ml-auto max-w-[11rem] sm:hidden" />
          </summary>
          <div className="max-h-[70vh] overflow-y-auto px-3 pb-4" tabIndex={0} aria-label="Admin sections">
            <AdminNav groups={groups} idPrefix="menu" />
          </div>
        </details>
      </header>

      <main id="main-content" tabIndex={-1} className="w-full px-4 pb-16 pt-6 outline-none sm:px-6 lg:pl-66">
        <div className="mx-auto w-full max-w-6xl">{children}</div>
      </main>
    </div>
  );
}
