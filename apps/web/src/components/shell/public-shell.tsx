import { ButtonLink } from "@recx/design";
import { getCurrentUser } from "@/lib/auth/session";
import { COLLEGE_NAME, PRODUCT_NAME } from "@/lib/brand/names";
import { CollegeLogo } from "@/components/brand/college-logo";
import { AppShell } from "@/components/shell/app-shell";
import { Wordmark } from "@/components/shell/wordmark";
import { ThemeToggle } from "@/components/theme/theme-toggle";

/**
 * The chrome of a page that is reachable signed out (/u/[handle], /judge).
 * Signed-in viewers get the normal app chrome; signed-out visitors get a
 * minimal header with Sign in. It grants nothing: who may see what is
 * decided by each page.
 */
export async function PublicShell({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (user) return <AppShell user={user}>{children}</AppShell>;

  return (
    <div className="app-backdrop min-h-dvh">
      <header className="glass sticky top-0 z-20 border-b border-border">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-2 px-4 sm:gap-4 sm:px-6">
          <Wordmark href="/login" />
          <div className="flex-1" />
          <ThemeToggle compact />
          <ButtonLink href="/login" size="md">
            Sign in
          </ButtonLink>
        </div>
      </header>
      <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-7xl px-4 pb-10 pt-6 outline-none sm:px-6">
        {children}
      </main>
      {/*
        A footer, for the signed-out visitor only (Phase 13b).

        This shell wraps the two pages somebody outside the college can
        land on -- a student's public profile and the judge's own
        specification -- and both are read by people deciding whether to
        believe what is on them. Whose platform it is belongs at the
        bottom of the page, and a signed-in viewer never sees this shell
        at all: they get the app chrome, which carries the mark in the
        sidebar.
      */}
      <footer className="mx-auto flex w-full max-w-7xl items-center gap-3 px-4 pb-10 sm:px-6">
        <CollegeLogo size="sm" decorative />
        <p className="text-xs text-text-secondary">
          {PRODUCT_NAME} · {COLLEGE_NAME}
        </p>
      </footer>
    </div>
  );
}
