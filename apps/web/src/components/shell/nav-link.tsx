"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { isNavActive, type ShellNavItem } from "@/components/shell/nav";

/**
 * The one client leaf of the shell navigation: it only decides
 * aria-current. Icons and labels arrive as server-rendered children, so the
 * sidebar and bottom bar ship no icon code to the browser.
 */
export function NavLink({
  href,
  match,
  className,
  activeClassName,
  inactiveClassName,
  children,
}: {
  href: string;
  match: ShellNavItem["match"];
  className: string;
  activeClassName: string;
  inactiveClassName: string;
  children: React.ReactNode;
}) {
  const active = isNavActive(usePathname(), { href, match });
  return (
    <Link
      href={href as never}
      aria-current={active ? "page" : undefined}
      className={`${className} ${active ? activeClassName : inactiveClassName}`}
    >
      {children}
    </Link>
  );
}
