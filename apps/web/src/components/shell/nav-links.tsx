"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@recx/design";

export interface NavItem {
  href: string;
  label: string;
}

/** `pathname` is typed nullable: with a pages/ directory (the sign-in page) Next types the hooks for both routers. */
function isActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Top-bar navigation with the current section marked (aria-current). */
export function NavLinks({ items }: { items: readonly NavItem[] }) {
  const pathname = usePathname();
  return (
    <ul className="flex items-center gap-1">
      {items.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                active
                  ? "bg-primary-subtle text-primary"
                  : "text-text-secondary hover:bg-primary-subtle hover:text-text",
              )}
            >
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
