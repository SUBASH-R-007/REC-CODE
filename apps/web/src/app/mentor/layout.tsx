import { requireMentorPage } from "@/lib/auth/guards";
import { RoleShell } from "@/components/staff/role-shell";

/**
 * Every mentor page lives under this layout. The role guard runs here and
 * again in each page — a layout guard alone is not RBAC — and the per-mentee
 * check in lib/auth/mentor-scope.ts runs inside each page on top of both.
 */
export default async function MentorLayout({ children }: { children: React.ReactNode }) {
  const user = await requireMentorPage();
  return (
    <RoleShell user={user} area="Mentor" home="/mentor" nav={[
        { href: "/mentor", label: "My mentees", match: "exact" },
        // Phase 12d. Moderation is college-wide, not per mentee: the queue
        // is about public posts, and one narrowed to a mentor's own
        // mentees would leave most of the board unmoderated while looking
        // staffed.
        { href: "/mentor/doubts", label: "Questions", match: "prefix" },
        { href: "/mentor/moderation", label: "Moderation", match: "prefix" },
        { href: "/mentor/experiences", label: "Interview submissions", match: "prefix" },
      ]}>
      {children}
    </RoleShell>
  );
}
