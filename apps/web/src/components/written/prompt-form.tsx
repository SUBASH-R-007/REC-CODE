"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { Button, Field, Input, Select, Textarea, useToast } from "@recx/design";
import {
  WRITTEN_KINDS,
  WRITTEN_KIND_HINT,
  WRITTEN_KIND_LABEL,
  WRITTEN_LIMITS,
  type WrittenKind,
} from "@recx/shared";
import { createWrittenPrompt } from "@/server/actions/written";

interface Row {
  label: string;
  guidance: string;
  weight: number;
}

const BLANK: Row = { label: "", guidance: "", weight: 3 };

/**
 * Writing a question, with its rubric (Phase 12i).
 *
 * The rubric is part of writing the question rather than something added
 * at marking time, because it is published WITH the question: a student
 * who can read what is being looked for can practise against it. The form
 * starts with two empty criteria for the same reason the server refuses
 * fewer — a one-line rubric is a mark with a label on it.
 */
export function PromptForm() {
  const router = useRouter();
  const { toast } = useToast();
  const [kind, setKind] = useState<WrittenKind>("SYSTEM_DESIGN");
  const [title, setTitle] = useState("");
  const [promptMd, setPrompt] = useState("");
  const [timeBoxMinutes, setTimeBox] = useState(45);
  const [rows, setRows] = useState<Row[]>([{ ...BLANK }, { ...BLANK }]);
  const [pending, startTransition] = useTransition();

  const setRow = (index: number, patch: Partial<Row>) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const result = await createWrittenPrompt({
            kind,
            title,
            promptMd,
            timeBoxMinutes,
            criteria: rows.map((row) => ({ label: row.label, guidance: row.guidance, weight: row.weight })),
          });
          if (!result.ok) {
            toast(result.error, "error");
            return;
          }
          toast("Written, as a draft. Publish it when the rubric reads right.", "success");
          setTitle("");
          setPrompt("");
          setRows([{ ...BLANK }, { ...BLANK }]);
          router.refresh();
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Kind" htmlFor="prompt-kind" hint={WRITTEN_KIND_HINT[kind]}>
          <Select id="prompt-kind" value={kind} onChange={(e) => setKind(e.target.value as WrittenKind)}>
            {WRITTEN_KINDS.map((option) => (
              <option key={option} value={option}>
                {WRITTEN_KIND_LABEL[option]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="About how long should it take?" htmlFor="prompt-timebox" hint="Advice on the page, not a timer.">
          <Input
            id="prompt-timebox"
            type="number"
            min={WRITTEN_LIMITS.timeBoxMinutes.min}
            max={WRITTEN_LIMITS.timeBoxMinutes.max}
            value={timeBoxMinutes}
            onChange={(e) => setTimeBox(Number(e.target.value))}
          />
        </Field>
      </div>

      <Field label="Title" htmlFor="prompt-title">
        <Input
          id="prompt-title"
          required
          minLength={WRITTEN_LIMITS.title.min}
          maxLength={WRITTEN_LIMITS.title.max}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </Field>

      <Field label="The question" htmlFor="prompt-body" hint="Markdown. Say what to assume and what to ignore.">
        <Textarea
          id="prompt-body"
          rows={8}
          required
          minLength={WRITTEN_LIMITS.prompt.min}
          maxLength={WRITTEN_LIMITS.prompt.max}
          value={promptMd}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </Field>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">The rubric, which students read before they answer</legend>
        {rows.map((row, index) => (
          <div key={index} className="rounded-xl border border-border bg-background p-3">
            <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
              <Field label={`Criterion ${index + 1}`} htmlFor={`criterion-${index}`}>
                <Input
                  id={`criterion-${index}`}
                  required
                  minLength={WRITTEN_LIMITS.criterionLabel.min}
                  maxLength={WRITTEN_LIMITS.criterionLabel.max}
                  value={row.label}
                  onChange={(e) => setRow(index, { label: e.target.value })}
                />
              </Field>
              <Field label="Weight" htmlFor={`weight-${index}`} hint="1–5">
                <Select
                  id={`weight-${index}`}
                  value={String(row.weight)}
                  onChange={(e) => setRow(index, { weight: Number(e.target.value) })}
                >
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="What a good answer does here (optional)" htmlFor={`guidance-${index}`}>
              <Input
                id={`guidance-${index}`}
                maxLength={WRITTEN_LIMITS.criterionGuidance.max}
                value={row.guidance}
                onChange={(e) => setRow(index, { guidance: e.target.value })}
              />
            </Field>
            {rows.length > WRITTEN_LIMITS.criteriaPerPrompt.min ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
                Remove
              </Button>
            ) : null}
          </div>
        ))}
        {rows.length < WRITTEN_LIMITS.criteriaPerPrompt.max ? (
          <Button type="button" size="sm" variant="outline" onClick={() => setRows((c) => [...c, { ...BLANK }])}>
            <Plus className="h-4 w-4" aria-hidden />
            Another criterion
          </Button>
        ) : null}
      </fieldset>

      <Button type="submit" className="min-h-11" loading={pending}>
        Save as a draft
      </Button>
    </form>
  );
}
