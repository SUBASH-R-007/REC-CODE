// Client-safe barrel. Palette derivation (./derive) and presets (./presets)
// are separate entry points and deliberately not re-exported here.

export { Avatar } from "./components/avatar";
export { Badge } from "./components/badge";
export { Button, ButtonLink, type ButtonProps } from "./components/button";
export { Card, CardBody, CardHeader } from "./components/card";
export { Dialog } from "./components/dialog";
export { Dropdown, DropdownItem } from "./components/dropdown";
export { EmptyState } from "./components/empty-state";
export { Field, Input, Label, Select, Textarea } from "./components/form";
export { ProgressBar, ProgressRing } from "./components/progress";
export { CardSkeleton, PageSkeleton, Skeleton } from "./components/skeleton";
export { StatCard } from "./components/stat";
export { Tab, TabList, TabPanel, Tabs } from "./components/tabs";
export { ToastProvider, useToast } from "./components/toast";

export {
  VERDICT_STYLE,
  VerdictBadge,
  type VerdictBorderCue,
  type VerdictSilhouette,
  type VerdictStyle,
} from "./components/verdict-badge";
export { DifficultyBadge } from "./components/difficulty-badge";
export { SolveStatus, type SolveState } from "./components/solve-status";

export {
  clamp,
  cn,
  formatBytes,
  formatDuration,
  formatSeconds,
  fullName,
  greetingForHour,
  initials,
  localDateString,
  percent,
  pluralize,
  publicName,
  roundMarks,
  truncate,
} from "./utils";
