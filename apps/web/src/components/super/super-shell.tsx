import type { User } from "@recx/db";
import { ShieldAlert } from "lucide-react";
import { ButtonLink } from "@recx/design";
import { UserMenu } from "@/components/shell/user-menu";
import { Wordmark } from "@/components/shell/wordmark";
import { SuperNav } from "@/components/super/super-nav";
import { SuperStrip } from "@/components/super/super-strip";
import { ThemeToggle } from "@/components/theme/theme-toggle";

/**
 * The separate /super chrome: its own header (a danger-toned "Super-admin"
 * label, icon plus text), the persistent audited strip, and a sidebar of
 * the twelve routes. The layout has already run the guard; this only
 * renders, and every page guards itself again.
 */
export function SuperShell({ user, children }: { user: Pick<User, "firstName" | "lastName" | "email" | "collegeId">; children: React.ReactNode }) {
  return (
    <div className="app-backdrop min-h-dvh">
      <header className="glass sticky top-0 z-20 border-b border-border">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-2 px-4 sm:gap-4 sm:px-6">
          <Wordmark href="/super" />
          <span className="inline-flex items-center gap-1 rounded-md border border-danger/30 bg-danger-subtle px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-danger">
            <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
            Super-admin
          </span>
          <div className="flex-1" />
          <ButtonLink href="/admin" variant="ghost" size="sm" className="hidden sm:inline-flex">
            Admin
          </ButtonLink>
          <ThemeToggle compact />
          <UserMenu
            firstName={user.firstName}
            lastName={user.lastName}
            email={user.email}
            collegeId={user.collegeId}
            roleLabel="Super admin"
          />
        </div>
      </header>
      <SuperStrip />
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 pb-16 pt-6 sm:px-6 lg:flex-row">
        <nav aria-label="Super-admin" className="lg:sticky lg:top-28 lg:w-56 lg:shrink-0 lg:self-start">
          <SuperNav />
        </nav>
        <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 outline-none">
          {children}
        </main>
      </div>
    </div>
  );
}
