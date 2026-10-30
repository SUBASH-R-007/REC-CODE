/**
 * The /super tree: one separate layout (app/super/layout.tsx) and these
 * thirteen routes, in sidebar order. test/super-nav.test.ts holds every href
 * to an implemented page. Showing a link is never the access check: every
 * page and action guards itself (requireSuperAdminPage / requireSuperAdmin).
 */
export interface SuperNavItem {
  href: string;
  label: string;
}

export const SUPER_NAV: readonly SuperNavItem[] = Object.freeze([
  { href: "/super", label: "Overview" },
  { href: "/super/users", label: "Users" },
  { href: "/super/roles", label: "Roles and scopes" },
  { href: "/super/settings/branding", label: "Branding" },
  { href: "/super/settings/policy", label: "Policy" },
  { href: "/super/settings/judge", label: "Judge settings" },
  { href: "/super/settings/ai", label: "AI helper" },
  { href: "/super/settings/integrations", label: "Integrations" },
  { href: "/super/audit", label: "Audit log" },
  { href: "/super/impersonate", label: "Impersonate" },
  { href: "/super/flags", label: "Flags" },
  { href: "/super/integrity", label: "Integrity calibration" },
  { href: "/super/jobs", label: "Jobs" },
  { href: "/super/data", label: "Data" },
]);

/** "/super" is active only on itself; every other entry also on its sub-paths. */
export function isSuperNavActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  if (href === "/super") return pathname === "/super";
  return pathname === href || pathname.startsWith(`${href}/`);
}
