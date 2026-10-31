import { requireSuperAdminPage } from "@/lib/auth/guards";
import { SuperShell } from "@/components/super/super-shell";

/**
 * The /super tree: a separate layout with its own shell and the persistent
 * "Super-admin — all actions are audited" strip. The guard runs here AND in
 * every page and action: a layout guard alone is not RBAC. While a
 * super-admin impersonates someone, the guard sees the target and
 * redirects away (the banner offers "End impersonation").
 */
export default async function SuperLayout({ children }: { children: React.ReactNode }) {
  const user = await requireSuperAdminPage();
  return <SuperShell user={user}>{children}</SuperShell>;
}
