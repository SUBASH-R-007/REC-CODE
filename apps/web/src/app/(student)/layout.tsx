import { requireUser } from "@/lib/auth/guards";
import { AppShell } from "@/components/shell/app-shell";

/**
 * Every authenticated product page lives under this group. The guard runs
 * here and again in each page/action that needs a role — a layout guard
 * alone is not RBAC.
 */
export default async function StudentLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  return <AppShell user={user}>{children}</AppShell>;
}
