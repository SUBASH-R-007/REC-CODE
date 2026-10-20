import { requirePlacementPage } from "@/lib/auth/guards";
import { RoleShell } from "@/components/staff/role-shell";

/**
 * Every placement-cell page lives under this layout. The role guard runs
 * here and again in each page — a layout guard alone is not RBAC.
 *
 * The tree is `/placement-cell`, not `/placement`: the student route keeps
 * the spec's `/placement`, and two App Router trees cannot resolve to the
 * same URL.
 */
export default async function PlacementCellLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePlacementPage();
  return (
    <RoleShell
      user={user}
      area="Placement cell"
      home="/placement-cell"
      nav={[{ href: "/placement-cell", label: "Overview", match: "exact" }]}
    >
      {children}
    </RoleShell>
  );
}
