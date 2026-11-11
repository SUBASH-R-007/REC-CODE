import { requireUser } from "@/lib/auth/guards";

/**
 * The arena has NO sidebar (SPEC §5): the screen belongs to the contest.
 * This layout is nested inside the (student) group, so the group's guard has
 * already run; it runs again here because a layout guard alone is not RBAC,
 * and the page itself checks registration.
 *
 * The AppShell of the (student) layout still wraps this — the arena opts out
 * of the shell's chrome by filling the width itself rather than by escaping
 * the route group, so the impersonation banner and the skip link keep
 * working.
 */
export default async function ArenaLayout({ children }: { children: React.ReactNode }) {
  await requireUser();
  return <div className="-mx-4 sm:-mx-6 lg:-mx-8">{children}</div>;
}
