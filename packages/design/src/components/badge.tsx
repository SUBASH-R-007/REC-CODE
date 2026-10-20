import { cn } from "../utils";

type Tone =
  | "default"
  | "primary"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "accent";

const tones: Record<Tone, string> = {
  default: "bg-primary-subtle/60 text-text-secondary border-border",
  primary: "bg-primary-subtle text-primary border-primary/20",
  success: "bg-success-subtle text-success border-success/20",
  warning: "bg-warning-subtle text-warning border-warning/25",
  danger: "bg-danger-subtle text-danger border-danger/20",
  info: "bg-info-subtle text-info border-info/20",
  accent: "bg-accent-subtle text-accent border-accent/25",
};

export function Badge({
  tone = "default",
  className,
  children,
}: {
  tone?: Tone;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
