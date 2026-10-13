import {
  Award,
  BookOpen,
  Brain,
  CalendarCheck,
  CircleCheck,
  Code,
  Crown,
  Flag,
  Flame,
  Footprints,
  Gem,
  GraduationCap,
  Lightbulb,
  ListChecks,
  Lock,
  Medal,
  Mountain,
  MountainSnow,
  Puzzle,
  Rocket,
  Shield,
  Sparkles,
  Star,
  Swords,
  Target,
  Timer,
  Trophy,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@recx/design";
import type { BadgeView } from "@/server/queries/profile";

/**
 * Badge.icon holds a lucide icon name ("flame", "calendar-check" or
 * "CalendarCheck"). The set below is curated so the profile does not pull
 * every lucide icon into the server bundle; an unknown name falls back to
 * Award. The icon is always decorative — the badge's name and description
 * are the text.
 */
const BADGE_ICONS: Readonly<Record<string, LucideIcon>> = {
  award: Award,
  bookopen: BookOpen,
  brain: Brain,
  calendarcheck: CalendarCheck,
  circlecheck: CircleCheck,
  code: Code,
  crown: Crown,
  flag: Flag,
  flame: Flame,
  footprints: Footprints,
  gem: Gem,
  graduationcap: GraduationCap,
  lightbulb: Lightbulb,
  listchecks: ListChecks,
  medal: Medal,
  mountain: Mountain,
  mountainsnow: MountainSnow,
  puzzle: Puzzle,
  rocket: Rocket,
  shield: Shield,
  sparkles: Sparkles,
  star: Star,
  swords: Swords,
  target: Target,
  timer: Timer,
  trophy: Trophy,
  zap: Zap,
};

export function badgeIcon(name: string): LucideIcon {
  return BADGE_ICONS[name.toLowerCase().replace(/[^a-z]/g, "")] ?? Award;
}

const EARNED_DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

/** Earned badges (and, on your own profile, the ones still to earn) — icon + name + text, never colour alone. */
export function BadgeShelf({ badges, emptyText }: { badges: readonly BadgeView[]; emptyText: string }) {
  if (badges.length === 0) {
    return <p className="text-sm text-text-secondary">{emptyText}</p>;
  }
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {badges.map((badge) => {
        const Icon = badgeIcon(badge.icon);
        const earned = badge.awardedAt !== null;
        return (
          <li
            key={badge.key}
            className={cn(
              "flex items-start gap-3 rounded-xl border p-3",
              earned ? "border-primary/25 bg-primary-subtle/40" : "border-dashed border-border-strong",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
                earned ? "bg-primary text-primary-fg" : "bg-background text-muted",
              )}
            >
              <Icon className="h-5 w-5" />
              {earned ? null : <Lock className="absolute -bottom-1 -right-1 h-4 w-4 rounded-full bg-surface p-0.5 text-muted" />}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-text">{badge.name}</span>
              <span className="block text-xs text-text-secondary">{badge.description}</span>
              <span className="mt-1 block text-xs font-medium text-muted">
                {badge.awardedAt ? `Earned ${EARNED_DATE.format(badge.awardedAt)}` : "Not earned yet"}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
