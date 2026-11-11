import Link from "next/link";
import type { NavIconKey } from "@/components/shell/nav";
import { NavIcon } from "@/components/shell/nav-icon";

/** A link item for UserMenu, rendered on the server and passed as a child. */
export function UserMenuLink({ href, icon, children }: { href: string; icon: NavIconKey; children: React.ReactNode }) {
  return (
    <Link
      href={href as never}
      role="menuitem"
      className="flex min-h-10 w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-text transition-colors hover:bg-primary-subtle"
    >
      <NavIcon name={icon} className="h-4 w-4" />
      {children}
    </Link>
  );
}
