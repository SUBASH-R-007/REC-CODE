import { PublicShell } from "@/components/shell/public-shell";

/**
 * /u/[handle] sits outside the (student) group because a PUBLIC profile is
 * reachable signed out. Signed-in viewers get the normal app chrome; signed-out
 * visitors get a minimal header with Sign in (components/shell/public-shell.tsx,
 * shared with /judge). Who may see which profile is decided per page by
 * canViewProfile() — this layout grants nothing.
 */
export default async function PublicProfileLayout({ children }: { children: React.ReactNode }) {
  return <PublicShell>{children}</PublicShell>;
}
