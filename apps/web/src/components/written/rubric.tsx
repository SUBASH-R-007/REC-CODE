import { WRITTEN_MARK_LABEL, WRITTEN_MARK_MAX } from "@recx/shared";
import type { CriterionView, MarkView } from "@/server/queries/written";

/**
 * The rubric, as the student reads it before they write and as the mark
 * reads afterwards (Phase 12i).
 *
 * One component for both, on purpose: the list a student practises
 * against and the list they are marked against must be visibly the same
 * list, and two components would eventually disagree.
 */
export function Rubric({
  criteria,
  outOf,
  marks,
}: {
  criteria: CriterionView[];
  outOf: number;
  marks?: MarkView[];
}) {
  const byCriterion = new Map((marks ?? []).map((mark) => [mark.criterionId, mark]));

  return (
    <div className="space-y-2">
      <ul className="space-y-2">
        {criteria.map((criterion) => {
          const mark = byCriterion.get(criterion.id);
          return (
            <li key={criterion.id} className="rounded-xl border border-border bg-background p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-medium">{criterion.label}</p>
                <p className="text-xs text-muted">
                  {mark ? (
                    <>
                      <span className="font-medium text-text">
                        {mark.points} / {WRITTEN_MARK_MAX}
                      </span>{" "}
                      · {WRITTEN_MARK_LABEL[mark.points]} · weight {criterion.weight}
                    </>
                  ) : (
                    <>
                      out of {WRITTEN_MARK_MAX}, weight {criterion.weight}
                    </>
                  )}
                </p>
              </div>
              {criterion.guidance ? <p className="mt-1 text-xs text-text-secondary">{criterion.guidance}</p> : null}
              {mark?.note ? <p className="mt-2 text-sm text-text-secondary">{mark.note}</p> : null}
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted">{outOf} weighted marks in all.</p>
    </div>
  );
}
