import { requirePageRole } from "@/lib/auth/guards";
import { describeScope, loadStudentScope } from "@/lib/auth/scope";
import { AdminShell } from "@/components/admin/admin-shell";

/**
 * Every admin page lives under this layout. The role guard runs here and
 * again in each page and action — a layout guard alone is not RBAC. The
 * viewer's AdminScope is loaded once per request (cached) for the scope
 * chip; each page loads it again through requireAdminScopePage().
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePageRole("ADMIN", "SUPER_ADMIN");
  const scope = await loadStudentScope(user);
  return (
    <AdminShell user={user} scopeLabel={describeScope(scope)}>
      {children}
    </AdminShell>
  );
}
