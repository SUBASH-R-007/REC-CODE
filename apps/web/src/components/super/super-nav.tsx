"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  Database,
  Flag,
  Gavel,
  KeyRound,
  LayoutDashboard,
  Palette,
  Plug,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  UserCog,
  Users,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@recx/design";
import { isSuperNavActive, SUPER_NAV } from "@/components/super/nav";

const ICONS: Readonly<Record<string, LucideIcon>> = {
  "/super": LayoutDashboard,
  "/super/users": Users,
  "/super/roles": KeyRound,
  "/super/settings/branding": Palette,
  "/super/settings/policy": ShieldCheck,
  "/super/settings/judge": Gavel,
  "/super/settings/integrations": Plug,
  "/super/audit": ScrollText,
  "/super/impersonate": UserCog,
  "/super/flags": Flag,
  "/super/integrity": ShieldAlert,
  "/super/jobs": Activity,
  "/super/data": Database,
};

/** Sidebar on wide screens, a wrapped list on narrow ones (no horizontal scroll). */
export function SuperNav() {
  const pathname = usePathname();
  return (
    <ul className="flex flex-wrap gap-1 lg:flex-col lg:flex-nowrap">
      {SUPER_NAV.map((item) => {
        const active = isSuperNavActive(pathname, item.href);
        const Icon = ICONS[item.href] ?? LayoutDashboard;
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                active
                  ? "bg-danger-subtle text-danger"
                  : "text-text-secondary hover:bg-primary-subtle hover:text-text",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden />
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
