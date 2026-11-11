import { DASHBOARD_ITEM, MOBILE_NAV, SECONDARY_NAV, visibleGroups, type ShellNavItem } from "@/components/shell/nav";
import { NavIcon } from "@/components/shell/nav-icon";
import { NavLink } from "@/components/shell/nav-link";

const SIDEBAR_LINK =
  "flex min-h-10 items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors";
// Active: a filled pill, a bar on the left edge and a heavier label —
// never colour alone. text-text on primary-subtle passes 4.5:1 in both
// themes (white on the dark-theme primary is 4.23:1, so it is not used).
const SIDEBAR_ACTIVE =
  "relative bg-primary-subtle font-semibold text-text before:absolute before:inset-y-2 before:left-0 before:w-1 before:rounded-r-full before:bg-primary";
const SIDEBAR_INACTIVE = "text-text-secondary hover:bg-primary-subtle hover:text-text";

function SidebarLink({ item }: { item: ShellNavItem }) {
  return (
    <NavLink
      href={item.href}
      match={item.match}
      className={SIDEBAR_LINK}
      activeClassName={SIDEBAR_ACTIVE}
      inactiveClassName={SIDEBAR_INACTIVE}
    >
      <NavIcon name={item.icon} className="h-[1.1rem] w-[1.1rem] shrink-0" />
      {item.label}
    </NavLink>
  );
}

/**
 * Sidebar navigation (>= 1024 px): Dashboard, then the PRACTICE / COMPETE /
 * ME groups. Server-rendered; only NavLink (aria-current) is client code.
 */
export function SidebarNav() {
  return (
    <nav aria-label="Primary" className="flex flex-col gap-5">
      <ul className="flex flex-col gap-0.5">
        <li>
          <SidebarLink item={DASHBOARD_ITEM} />
        </li>
      </ul>
      {visibleGroups().map((group) => {
        const labelId = `shell-nav-${group.id}`;
        return (
          <div key={group.id}>
            <p id={labelId} className="px-3 pb-1.5 text-[0.68rem] font-semibold uppercase tracking-wider text-muted">
              {group.label}
            </p>
            <ul aria-labelledby={labelId} className="flex flex-col gap-0.5">
              {group.items.map((entry) => (
                <li key={entry.href}>
                  <SidebarLink item={entry} />
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

/** Help and accessibility links at the foot of the sidebar. */
export function SidebarFooterNav() {
  return (
    <nav aria-label="Help">
      <ul className="flex flex-col gap-0.5">
        {SECONDARY_NAV.map((entry) => (
          <li key={entry.href}>
            <NavLink
              href={entry.href}
              match={entry.match}
              className="flex min-h-9 items-center gap-2.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
              activeClassName="bg-primary-subtle font-semibold text-text"
              inactiveClassName="text-text-secondary hover:bg-primary-subtle hover:text-text"
            >
              <NavIcon name={entry.icon} className="h-4 w-4 shrink-0" />
              {entry.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * Five-item bottom bar below 1024 px. Each target is the full cell (at least
 * 56 px tall), icon above a text label — never an icon alone.
 */
export function MobileNav() {
  return (
    <nav
      aria-label="Quick navigation"
      className="glass fixed inset-x-0 bottom-0 z-30 border-t border-border pb-[env(safe-area-inset-bottom)] lg:hidden group-has-[[data-shell-bleed]]/shell:hidden"
    >
      <ul className="flex items-stretch justify-around">
        {MOBILE_NAV.map((entry) => (
          <li key={entry.href} className="flex flex-1">
            <NavLink
              href={entry.href}
              match={entry.match}
              className="flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[0.7rem] font-medium transition-colors"
              // The current section gets a bar on its top edge and a heavier
              // label as well as the colour: never colour alone.
              activeClassName="relative font-semibold text-text before:absolute before:inset-x-5 before:top-0 before:h-1 before:rounded-b-full before:bg-primary"
              inactiveClassName="text-text-secondary hover:text-text"
            >
              <NavIcon name={entry.icon} className="h-5 w-5" />
              {entry.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
