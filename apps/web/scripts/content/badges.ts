/**
 * The badge catalogue. `icon` is a lucide icon name (kebab-case, as in the
 * lucide icon set: "flame", "calendar-check"); the UI always renders it next
 * to the badge's name, never as colour or an icon alone. Awarding is the
 * progress pipeline's job — the seed only keeps these rows in step.
 */
export interface BadgeDefinition {
  key: string;
  name: string;
  description: string;
  icon: string;
  sortOrder: number;
}

export const BADGES: readonly BadgeDefinition[] = [
  { key: "first-solve", name: "First Solve", description: "Solved your first problem.", icon: "flag", sortOrder: 10 },
  { key: "ten-solves", name: "Ten Solved", description: "Solved 10 different problems.", icon: "list-checks", sortOrder: 20 },
  { key: "fifty-solves", name: "Fifty Solved", description: "Solved 50 different problems.", icon: "trophy", sortOrder: 30 },
  { key: "first-medium", name: "First Medium", description: "Solved your first Medium problem.", icon: "mountain", sortOrder: 40 },
  { key: "first-hard", name: "First Hard", description: "Solved your first Hard problem.", icon: "mountain-snow", sortOrder: 50 },
  {
    key: "streak-7",
    name: "7-Day Streak",
    description: "Submitted a solution on 7 campus days in a row.",
    icon: "flame",
    sortOrder: 60,
  },
  {
    key: "streak-30",
    name: "30-Day Streak",
    description: "Submitted a solution on 30 campus days in a row.",
    icon: "calendar-check",
    sortOrder: 70,
  },
];
