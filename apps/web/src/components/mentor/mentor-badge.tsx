import { Badge } from "@recx/design";
import { MENTOR_BADGE_DESCRIPTION, MENTOR_BADGE_LABEL } from "@recx/shared";

/**
 * The visible marker for a TA or mentor (Phase 9d).
 *
 * It ships now, two phases before the discussion powers it belongs to,
 * because SPEC §4 names the badge as part of the ROLE: a student told to
 * "ask your mentor" has to be able to tell which of the people answering is
 * one. The copy lives in `@recx/shared` so a test can assert it rather than
 * a redesign quietly dropping it.
 *
 * The description is the title AND the accessible name, because the badge is
 * two words and the two words do not say what the person can see. A student
 * who does not know what a mentor can see will assume the worst, and the
 * worst is the thing that stops them asking for help.
 */
export function MentorBadge({ className }: { className?: string }) {
  return (
    <Badge tone="info" className={className}>
      <span title={MENTOR_BADGE_DESCRIPTION}>{MENTOR_BADGE_LABEL}</span>
      <span className="sr-only">. {MENTOR_BADGE_DESCRIPTION}</span>
    </Badge>
  );
}
