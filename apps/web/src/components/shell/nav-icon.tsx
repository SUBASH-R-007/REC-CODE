import {
  Accessibility,
  Bell,
  Bookmark,
  Calculator,
  CalendarHeart,
  CircleQuestionMark,
  Cpu,
  Swords,
  SquareCode,
  GraduationCap,
  Briefcase,
  History,
  LayoutDashboard,
  ListChecks,
  Target,
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
  revision: History,
  contests: Swords,
  aptitude: Calculator,
  placement: Target,
  interviews: Briefcase,
  leaderboard: Trophy,
  profile: UserRound,
  bookmarks: Bookmark,
  notes: StickyNote,
  notifications: Bell,
  leave: CalendarHeart,
  help: CircleQuestionMark,
  judge: Cpu,
  accessibility: Accessibility,
};

/** Decorative icon for a nav entry; the visible label carries the meaning. */
export function NavIcon({ name, className }: { name: NavIconKey; className?: string }) {
  const Icon = ICONS[name];
  return <Icon className={className} aria-hidden />;
}
