"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Undo2 } from "lucide-react";
import { Button, Dialog, Field, Select, Textarea, useToast } from "@recx/design";
import {
  WRITTEN_LIMITS,
  WRITTEN_MARK_LABEL,
  WRITTEN_MARK_MAX,
  WRITTEN_MARK_MIN,
  WRITTEN_NOTICES,
  rubricScore,
  scoreLine,
} from "@recx/shared";
import { gradeWrittenAnswer, handBackWrittenAnswer } from "@/server/actions/written";
import type { CriterionView } from "@/server/queries/written";

/**
 * Marking one answer against the rubric (Phase 12i).
 *
 * Every criterion starts UNMARKED rather than at a middle value: a
 * default is a mark nobody made, and the server refuses a rubric with a
 * gap in it anyway. The running total is shown as it is filled in, with
 * the same arithmetic the server does, so a grader can see what they are
 * about to send.
 */
export function GradeForm({ answerId, criteria }: { answerId: string; criteria: CriterionView[] }) {
  const router = useRouter();
  const { toast } = useToast();
  const [points, setPoints] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [overallMd, setOverall] = useState("");
  const [handingBack, setHandingBack] = useState(false);
  const [pending, startTransition] = useTransition();

  const marked = criteria.filter((c) => points[c.id] !== undefined && points[c.id] !== "");
  const complete = marked.length === criteria.length;
  const running = useMemo(
    () => rubricScore(criteria, criteria.map((c) => ({ points: Number(points[c.id] ?? 0) }))),
    [criteria, points],
  );

  return (
    <>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          startTransition(async () => {
            const result = await gradeWrittenAnswer({
              answerId,
              marks: criteria.map((criterion) => ({
                criterionId: criterion.id,
                points: Number(points[criterion.id]),
                note: notes[criterion.id] ?? "",
              })),
              overallMd,
            });
            if (!result.ok) {
              toast(result.error, "error");
              return;
            }
            toast("Marked. They can read it now.", "success");
            router.push("/mentor/written");
          });
        }}
      >
        <ul className="space-y-3">
          {criteria.map((criterion) => (
            <li key={criterion.id} className="rounded-xl border border-border bg-background p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{criterion.label}</p>
                  {criterion.guidance ? (
                    <p className="mt-0.5 text-xs text-text-secondary">{criterion.guidance}</p>
                  ) : null}
                </div>
                <Field label={`Weight ${criterion.weight}`} htmlFor={`mark-${criterion.id}`}>
                  <Select
                    id={`mark-${criterion.id}`}
                    value={points[criterion.id] ?? ""}
                    onChange={(e) => setPoints((p) => ({ ...p, [criterion.id]: e.target.value }))}
                  >
                    <option value="">Not marked</option>
                    {Array.from({ length: WRITTEN_MARK_MAX - WRITTEN_MARK_MIN + 1 }, (_, i) => WRITTEN_MARK_MIN + i).map(
                      (n) => (
                        <option key={n} value={n}>
                          {n} — {WRITTEN_MARK_LABEL[n]}
                        </option>
                      ),
                    )}
                  </Select>
                </Field>
              </div>
              <Field label="A line on this one (optional)" htmlFor={`note-${criterion.id}`}>
                <Textarea
                  id={`note-${criterion.id}`}
                  rows={2}
                  maxLength={WRITTEN_LIMITS.markNote.max}
                  value={notes[criterion.id] ?? ""}
                  onChange={(e) => setNotes((n) => ({ ...n, [criterion.id]: e.target.value }))}
                />
              </Field>
            </li>
          ))}
        </ul>

        <p className="text-sm" aria-live="polite">
          {complete ? scoreLine(running) : `${marked.length} of ${criteria.length} criteria marked.`}
        </p>

        <Field
          label="What should they do differently next time?"
          htmlFor="written-overall"
          hint="Markdown. One concrete thing beats five general ones."
        >
          <Textarea
            id="written-overall"
            rows={6}
            required
            minLength={WRITTEN_LIMITS.overallNote.min}
            maxLength={WRITTEN_LIMITS.overallNote.max}
            value={overallMd}
            onChange={(e) => setOverall(e.target.value)}
          />
        </Field>

        <div className="flex flex-wrap gap-2">
          <Button type="submit" className="min-h-11" loading={pending} disabled={!complete}>
            <Check className="h-4 w-4" aria-hidden />
            Save the mark
          </Button>
          <Button type="button" variant="outline" className="min-h-11" onClick={() => setHandingBack(true)}>
            <Undo2 className="h-4 w-4" aria-hidden />
            Hand it back unmarked
          </Button>
        </div>
        <p className="text-xs text-muted">{WRITTEN_NOTICES.gradingCountsForNothing}</p>
      </form>

      {handingBack ? (
        <HandBackDialog answerId={answerId} onClose={() => setHandingBack(false)} />
      ) : null}
    </>
  );
}

function HandBackDialog({ answerId, onClose }: { answerId: string; onClose: () => void }) {
  const router = useRouter();
  const { toast } = useToast();
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();

  return (
    <Dialog open onClose={onClose} title="Hand it back unmarked" size="sm">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          startTransition(async () => {
            const result = await handBackWrittenAnswer({ answerId, note });
            if (!result.ok) {
              toast(result.error, "error");
              return;
            }
            toast("Handed back. It is in their drafts with your note.", "success");
            router.push("/mentor/written");
          });
        }}
      >
        <p className="text-sm text-text-secondary">{WRITTEN_NOTICES.handBack}</p>
        <Field label="What is missing?" htmlFor="hand-back-note" hint="They are shown this, word for word.">
          <Textarea
            id="hand-back-note"
            rows={3}
            required
            minLength={10}
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Keep marking
          </Button>
          <Button type="submit" loading={pending}>
            Hand it back
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
