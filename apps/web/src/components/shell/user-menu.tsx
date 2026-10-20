"use client";

import { useTransition } from "react";
import { ChevronDown, LogOut } from "lucide-react";
import { Avatar, Dropdown, DropdownItem, fullName } from "@recx/design";
import { ThemeMenuItems } from "@/components/shell/theme-menu-items";
import { logout } from "@/server/actions/auth";

/**
 * Account menu: who is signed in (name, role, roll number — the viewer's
 * own details), optional extra menu items rendered by the server (links),
 * the colour theme on narrow screens, and Sign out.
 */
export function UserMenu({
  firstName,
  lastName,
  email,
  collegeId,
  roleLabel,
  themeOnNarrow = false,
  children,
}: {
  firstName: string;
  lastName: string;
  email: string;
  collegeId: string;
  roleLabel: string;
  /** Offer the theme choice inside the menu below 640 px. */
  themeOnNarrow?: boolean;
  /** Extra menu items (e.g. UserMenuLink), rendered between identity and Sign out. */
  children?: React.ReactNode;
}) {
  const [signingOut, startTransition] = useTransition();
  const name = fullName({ firstName, lastName });

  return (
    <Dropdown
      triggerLabel="Account menu"
      trigger={
        <span className="flex min-h-10 items-center gap-2 rounded-xl p-1 pr-2 transition-colors hover:bg-primary-subtle">
          <Avatar firstName={firstName} lastName={lastName} size="sm" />
          <span className="hidden text-left leading-tight sm:block">
            <span className="block max-w-36 truncate text-sm font-medium text-text">{name}</span>
            <span className="block text-[0.65rem] text-text-secondary">{roleLabel}</span>
          </span>
          <ChevronDown className="h-3.5 w-3.5 text-muted" aria-hidden />
        </span>
      }
    >
      <div role="none" className="border-b border-border px-3 py-2">
        <p className="truncate text-sm font-medium text-text">{name}</p>
        <p className="truncate text-xs text-text-secondary">
          {roleLabel} · {collegeId}
        </p>
        <p className="truncate text-xs text-text-secondary">{email}</p>
      </div>
      {children ? (
        <div role="none" className="border-b border-border py-1">
          {children}
        </div>
      ) : null}
      {themeOnNarrow ? (
        <div role="none" className="border-b border-border py-1 sm:hidden">
          <ThemeMenuItems />
        </div>
      ) : null}
      <div role="none" className="pt-1">
        <DropdownItem
          destructive
          onClick={() =>
            startTransition(async () => {
              await logout();
            })
          }
        >
          <LogOut className="h-4 w-4" aria-hidden />
          {signingOut ? "Signing out…" : "Sign out"}
        </DropdownItem>
      </div>
    </Dropdown>
  );
}
