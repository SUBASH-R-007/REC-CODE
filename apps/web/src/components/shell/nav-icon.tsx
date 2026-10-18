import {
  Accessibility,
  Bell,
  Bookmark,
  CircleQuestionMark,
  Cpu,
  Swords,
  SquareCode,
  GraduationCap,
  LayoutDashboard,
  ListChecks,
  StickyNote,
  Trophy,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import type { NavIconKey } from "@/components/shell/nav";

const ICONS: Readonly<Record<NavIconKey, LucideIcon>> = {
  dashboard: LayoutDashboard,
  problems: SquareCode,
  sheets: ListChecks,
  learn: GraduationCap,
  contests: Swords,
  leaderboard: Trophy,
  profile: UserRound,
  bookmarks: Bookmark,
  notes: StickyNote,
  notifications: Bell,
  help: CircleQuestionMark,
  judge: Cpu,
  accessibility: Accessibility,
};

/** Decorative icon for a nav entry; the visible label carries the meaning. */
export function NavIcon({ name, className }: { name: NavIconKey; className?: string }) {
  const Icon = ICONS[name];
  return <Icon className={className} aria-hidden />;
}
