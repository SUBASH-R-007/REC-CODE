import type { Role, User } from "@recx/db";
import { db } from "@/lib/db";
import { COLLEGE_NAME } from "@/lib/brand/names";
import { NotificationsBell } from "@/components/shell/notifications-bell";
import { PaletteLauncher } from "@/components/shell/palette-launcher";
import { MobileNav, SidebarFooterNav, SidebarNav } from "@/components/shell/sidebar-nav";
import { UserMenu } from "@/components/shell/user-menu";
import { UserMenuLink } from "@/components/shell/user-menu-link";
import { Wordmark } from "@/components/shell/wordmark";
import { ThemeToggle } from "@/components/theme/theme-toggle";

const ROLE_LABELS: Record<Role, string> = {
  STUDENT: "Student",
  TA_MENTOR: "TA / Mentor",
  ADMIN: "Administrator",
  PLACEMENT_OFFICER: "Placement officer",
  SUPER_ADMIN: "Super admin",
};

/**
 * Authenticated student chrome, matching the REC Learning shell:
 *   - >= 1024 px: fixed sidebar (Dashboard + PRACTICE / COMPETE / ME groups,
 *     help links) and a glass sticky top bar;
 *   - <  1024 px: the top bar plus a five-item bottom bar.
 * The top bar holds the Ctrl/Cmd+K search, the notifications bell (unread
 * count), the theme switch and the account menu. Pages that need the whole
 * viewport (the workspace) opt in with <WorkspaceFrame> — see
 * components/shell/workspace-frame.tsx.
 *
 * The caller (the (student) layout) has already run the page guard; this
 * component reads only the viewer's own unread count.
 */
export async function AppShell({ user, children }: { user: User; children: React.ReactNode }) {
  const unread = await db.notification.count({ where: { userId: user.id, readAt: null } });

  return (
    <div className="group/shell app-backdrop min-h-dvh [--shell-top:3.5rem]">
      <aside
        aria-label="Sidebar"
        className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-border bg-surface/80 backdrop-blur-sm lg:flex group-has-[[data-shell-bleed]]/shell:hidden"
      >
        <div className="flex h-14 shrink-0 items-center px-4">
          <Wordmark href="/dashboard" />
        </div>
        <div className="scroll-thin flex-1 overflow-y-auto px-3 pb-4 pt-2">
          <SidebarNav />
        </div>
        <div className="border-t border-border px-3 py-3">
          <SidebarFooterNav />
          <p className="px-3 pt-2 text-[0.68rem] leading-relaxed text-text-secondary">{COLLEGE_NAME}</p>
        </div>
      </aside>

      <header
        className="glass sticky top-0 z-20 flex h-14 items-center gap-1.5 border-b border-border px-4 sm:gap-2 sm:px-6 lg:pl-64 group-has-[[data-shell-bleed]]/shell:lg:pl-6"
      >
        <div className="flex items-center lg:hidden group-has-[[data-shell-bleed]]/shell:lg:flex">
          <Wordmark href="/dashboard" />
        </div>
        <div className="flex-1" />
        <PaletteLauncher />
        <NotificationsBell unread={unread} />
        {/* Room for the theme switch from 640 px; below that it lives in the account menu. */}
        <div className="hidden sm:block [&_button]:p-2">
          <ThemeToggle />
        </div>
        <UserMenu
          firstName={user.firstName}
          lastName={user.lastName}
          email={user.email}
          collegeId={user.collegeId}
          roleLabel={ROLE_LABELS[user.role]}
          themeOnNarrow
        >
          <UserMenuLink href="/profile" icon="profile">
            Profile and settings
          </UserMenuLink>
          <UserMenuLink href="/help" icon="help">
            How judging works
          </UserMenuLink>
          <UserMenuLink href="/accessibility" icon="accessibility">
            Accessibility
          </UserMenuLink>
        </UserMenu>
      </header>

      <main
        id="main-content"
        tabIndex={-1}
        className={[
          "mx-auto w-full max-w-6xl px-4 pb-28 pt-6 outline-none sm:px-6",
          "lg:max-w-none lg:pb-12 lg:pl-[17rem] lg:pr-8 xl:max-w-[88rem]",
          // Full-bleed (WorkspaceFrame): no gutters, no width cap, no sidebar
          // offset. Literal class names: Tailwind only sees what is written.
          "group-has-[[data-shell-bleed]]/shell:max-w-none group-has-[[data-shell-bleed]]/shell:p-0",
        ].join(" ")}
      >
        {children}
      </main>

      <MobileNav />
    </div>
  );
}
