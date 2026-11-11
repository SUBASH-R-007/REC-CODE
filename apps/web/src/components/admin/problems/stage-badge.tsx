import "server-only";
import { Archive, BadgeCheck, CheckCircle2, Eye, History, PenLine } from "lucide-react";
import { Badge } from "@recx/design";
import { REVIEW_STAGE_LABEL, type ReviewStage } from "@recx/shared/authoring";

const STYLE: Record<ReviewStage, { tone: "default" | "primary" | "success" | "warning" | "info" | "accent"; Icon: typeof PenLine }> = {
  DRAFT: { tone: "default", Icon: PenLine },
  IN_REVIEW: { tone: "info", Icon: Eye },
  APPROVED: { tone: "accent", Icon: BadgeCheck },
  PUBLISHED: { tone: "success", Icon: CheckCircle2 },
  SUPERSEDED: { tone: "default", Icon: History },
  RETIRED: { tone: "warning", Icon: Archive },
};

/** A revision's review stage: icon and text, never colour alone. */
export function StageBadge({ stage }: { stage: ReviewStage }) {
  const { tone, Icon } = STYLE[stage];
  return (
    <Badge tone={tone}>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {REVIEW_STAGE_LABEL[stage]}
    </Badge>
  );
}
