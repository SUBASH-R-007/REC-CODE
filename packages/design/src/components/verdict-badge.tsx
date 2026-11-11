import {
  AlertTriangle,
  CheckCircle2,
  CircleDotDashed,
  Clock,
  FileOutput,
  FileWarning,
  Hourglass,
  Loader2,
  MemoryStick,
  ServerCrash,
  SkipForward,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { VERDICT_CODE, VERDICT_LABEL, type VerdictDisplay } from "@recx/shared";
import { cn } from "../utils";

/** Shape cue on the badge's left edge — readable without colour. */
export type VerdictBorderCue = "solid" | "dashed" | "dotted" | "none";

/** The icon's outline, so verdicts differ in silhouette as well as hue. */
export type VerdictSilhouette =
  | "circle"
  | "dashed-circle"
  | "triangle"
  | "document"
  | "clock"
  | "chip"
  | "skip"
  | "hourglass"
  | "spinner"
  | "server";

export interface VerdictStyle {
  /** Monospace short code; null for pending states, which have none. */
  code: string | null;
  /** Token colour classes. */
  tone: string;
  icon: LucideIcon;
  silhouette: VerdictSilhouette;
  border: VerdictBorderCue;
  /** Spins only under motion-safe; static with reduced motion. */
  spin: boolean;
}

function row(
  verdict: VerdictDisplay,
  tone: string,
  icon: LucideIcon,
  silhouette: VerdictSilhouette,
  border: VerdictBorderCue,
  spin = false,
): VerdictStyle {
  const pending = verdict === "QUEUED" || verdict === "RUNNING";
  return { code: pending ? null : VERDICT_CODE[verdict], tone, icon, silhouette, border, spin };
}

/**
 * Every verdict renders with four independent encodings: token colour, a
 * distinct icon silhouette, the full text label and a monospace code (plus a
 * left-edge shape cue). Colour is never the only signal.
 */
export const VERDICT_STYLE: Readonly<Record<VerdictDisplay, VerdictStyle>> = {
  AC: row("AC", "text-success bg-success-subtle", CheckCircle2, "circle", "solid"),
  WA: row("WA", "text-danger bg-danger-subtle", XCircle, "circle", "solid"),
  TLE: row("TLE", "text-warning bg-warning-subtle", Clock, "clock", "dashed"),
  MLE: row("MLE", "text-warning bg-warning-subtle", MemoryStick, "chip", "dashed"),
  OLE: row("OLE", "text-warning bg-warning-subtle", FileOutput, "document", "dashed"),
  // A triangle, deliberately not a circle: a crash must not read as WA.
  RE: row("RE", "text-danger bg-danger-subtle", AlertTriangle, "triangle", "dotted"),
  // Info blue: "your code never ran" is a different kind of problem from "too slow".
  CE: row("CE", "text-info bg-info-subtle", FileWarning, "document", "dotted"),
  PARTIAL: row("PARTIAL", "text-accent bg-accent-subtle", CircleDotDashed, "dashed-circle", "solid"),
  SKIPPED: row("SKIPPED", "text-muted bg-surface", SkipForward, "skip", "none"),
  QUEUED: row("QUEUED", "text-muted bg-surface border-border", Hourglass, "hourglass", "none"),
  RUNNING: row("RUNNING", "text-info bg-info-subtle", Loader2, "spinner", "none", true),
  IE: row("IE", "text-muted bg-surface border-border-strong", ServerCrash, "server", "none"),
};

// border-dashed / border-dotted set --tw-border-style, which border-l-[3px]
// reads for the left edge. The other edges stay 1px transparent, so only
// the left edge shows the cue.
const BORDER_CUE: Record<VerdictBorderCue, string> = {
  solid: "border-l-[3px] border-l-current border-solid",
  dashed: "border-l-[3px] border-l-current border-dashed",
  dotted: "border-l-[3px] border-l-current border-dotted",
  none: "",
};

/** The only way a verdict is rendered anywhere in REC Code. */
export function VerdictBadge({
  verdict,
  size = "md",
  passed,
  total,
  className,
}: {
  verdict: VerdictDisplay;
  size?: "sm" | "md";
  /** PARTIAL only: tests passed, shown as "passed/total". */
  passed?: number;
  total?: number;
  className?: string;
}) {
  const style = VERDICT_STYLE[verdict];
  const Icon = style.icon;
  const showCount =
    verdict === "PARTIAL" &&
    typeof passed === "number" &&
    typeof total === "number" &&
    total > 0;
  return (
    <span
      data-verdict={verdict}
      className={cn(
        "inline-flex items-center rounded-md border border-transparent font-medium whitespace-nowrap",
        size === "sm" ? "h-6 gap-1 px-1.5 text-xs" : "h-7 gap-1.5 px-2 text-sm",
        style.tone,
        BORDER_CUE[style.border],
        className,
      )}
    >
      <Icon
        aria-hidden
        className={cn(
          "shrink-0",
          size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4",
          style.spin && "motion-safe:animate-spin",
        )}
      />
      {style.code ? (
        <span aria-hidden className="font-mono text-[0.85em] font-semibold">
          {style.code}
        </span>
      ) : null}
      <span>{VERDICT_LABEL[verdict]}</span>
      {showCount ? (
        <>
          <span aria-hidden className="font-mono tabular-nums">
            {passed}/{total}
          </span>
          <span className="sr-only">
            , {passed} of {total} tests passed
          </span>
        </>
      ) : null}
    </span>
  );
}
