"use client";

import { useId, useState } from "react";
import { Button, Field, Input, Select, Textarea } from "@recx/design";
import { addDraftTests, removeDraftTests, setDraftSubtasks, updateDraftTest } from "@/server/actions/admin-problem-content";
import { useActionRunner, useDraftSeq } from "./use-action";

/**
 * Test-case editing for a DRAFT revision: add one test, remove tests,
 * change a test's flags, and edit the subtask table. Every change is a
 * "judging" edit — validation must run again before publishing.
 *
 * Accessible names on this page: "Input", "Expected output", "Sample" and
 * "Add test case" name exactly one control each.
 */

function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="text-sm text-danger">
      {error}
    </p>
  ) : null;
}

export function AddTestForm({ scoring, interactive = false }: { scoring: string; interactive?: boolean }) {
  const id = useId();
  const seq = useDraftSeq();
  const { run, pending, error } = useActionRunner();
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [sample, setSample] = useState(false);
  const [subtask, setSubtask] = useState("");
  const [points, setPoints] = useState("");

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        run(
          () =>
            addDraftTests({
              versionId: seq.versionId,
              expectedEditSeq: seq.editSeq,
              tests: [
                {
                  input,
                  output,
                  isSample: sample,
                  subtaskIndex: subtask.trim() === "" ? null : Number(subtask),
                  points: points.trim() === "" ? null : Number(points),
                },
              ],
            }),
          {
            success: (d) => `Test ${d.indexes[0]} added.`,
            onSuccess: (d) => {
              seq.setEditSeq(d.editSeq);
              setInput("");
              setOutput("");
              setSample(false);
            },
          },
        );
      }}
    >
      <div className={interactive ? "grid gap-4" : "grid gap-4 lg:grid-cols-2"}>
        <Field
          label="Input"
          htmlFor={`${id}-in`}
          hint={
            interactive
              ? "The interactor's data for this case — the secret it keeps and the budget it allows. The student's program never reads it."
              : "Exactly what the program reads (end with a newline)."
          }
        >
          <Textarea id={`${id}-in`} rows={6} className="font-mono text-xs" spellCheck={false} value={input} onChange={(e) => setInput(e.target.value)} />
        </Field>
        {/* Phase 12l: an interactive problem compares no output. The field
            is absent rather than present and ignored, and the version's
            cases are stored with the empty blob. */}
        {!interactive && (
          <Field label="Expected output" htmlFor={`${id}-out`}>
            <Textarea id={`${id}-out`} rows={6} className="font-mono text-xs" spellCheck={false} value={output} onChange={(e) => setOutput(e.target.value)} />
          </Field>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex items-center gap-2 text-sm text-text">
          <input type="checkbox" checked={sample} onChange={(e) => setSample(e.target.checked)} className="h-4 w-4 accent-primary" />
          Sample
        </label>
        {scoring === "SUBTASK" && (
          <Field label="Subtask number" htmlFor={`${id}-sub`}>
            <Input id={`${id}-sub`} type="number" min={1} max={100} className="w-28" value={subtask} onChange={(e) => setSubtask(e.target.value)} />
          </Field>
        )}
        {scoring === "PER_TEST" && (
          <Field label="Points" htmlFor={`${id}-pts`}>
            <Input id={`${id}-pts`} type="number" min={1} max={1000} className="w-28" value={points} onChange={(e) => setPoints(e.target.value)} />
          </Field>
        )}
      </div>
      <p className="text-xs text-muted">
        Samples are shown to students in the statement. Larger or binary test sets go through an import package (up to 64 MB a file).
      </p>
      <ErrorLine error={error} />
      <Button type="submit" loading={pending}>
        Add test case
      </Button>
    </form>
  );
}

export function RemoveTestButton({ index }: { index: number }) {
  const seq = useDraftSeq();
  const { run, pending } = useActionRunner();
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      loading={pending}
      aria-label={`Remove test ${index}`}
      onClick={() =>
        run(() => removeDraftTests({ versionId: seq.versionId, expectedEditSeq: seq.editSeq, indexes: [index] }), {
          success: `Test ${index} removed; later tests were renumbered.`,
          onSuccess: (d) => seq.setEditSeq(d.editSeq),
        })
      }
    >
      Remove
    </Button>
  );
}

export function ChangeTestForm({ tests }: { tests: { index: number; isSample: boolean; subtaskIndex: number | null; points: number | null }[] }) {
  const id = useId();
  const seq = useDraftSeq();
  const { run, pending, error } = useActionRunner();
  const [index, setIndex] = useState(tests[0]?.index ?? 0);
  const current = tests.find((t) => t.index === index);
  if (tests.length === 0) return null;
  return (
    <form
      key={`${index}-${seq.editSeq}`}
      className="flex flex-wrap items-end gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        const num = (name: string) => {
          const v = String(form.get(name) ?? "").trim();
          return v === "" ? null : Number(v);
        };
        run(
          () =>
            updateDraftTest({
              versionId: seq.versionId,
              expectedEditSeq: seq.editSeq,
              index,
              isSample: form.get("visible") === "on",
              subtaskIndex: num("subtask"),
              points: num("points"),
            }),
          { success: `Test ${index} updated.`, onSuccess: (d) => seq.setEditSeq(d.editSeq) },
        );
      }}
    >
      <Field label="Test number" htmlFor={`${id}-index`}>
        <Select id={`${id}-index`} value={index} onChange={(e) => setIndex(Number(e.target.value))} className="w-28">
          {tests.map((t) => (
            <option key={t.index} value={t.index}>
              {t.index}
            </option>
          ))}
        </Select>
      </Field>
      <label className="flex items-center gap-2 pb-2.5 text-sm text-text">
        <input type="checkbox" name="visible" defaultChecked={current?.isSample ?? false} className="h-4 w-4 accent-primary" />
        Shown to students as an example
      </label>
      <Field label="Subtask" htmlFor={`${id}-subtask`}>
        <Input id={`${id}-subtask`} name="subtask" type="number" min={1} max={100} className="w-24" defaultValue={current?.subtaskIndex ?? ""} />
      </Field>
      <Field label="Test points" htmlFor={`${id}-points`}>
        <Input id={`${id}-points`} name="points" type="number" min={1} max={1000} className="w-24" defaultValue={current?.points ?? ""} />
      </Field>
      <Button type="submit" variant="outline" loading={pending}>
        Save test settings
      </Button>
      <ErrorLine error={error} />
    </form>
  );
}

/** "index points [dependsOn…]" per line, e.g. "2 60 1". */
function formatSubtasks(rows: { index: number; points: number; aggregation: string; dependsOn: number[] }[]): string {
  return rows.map((s) => [s.index, s.points, ...s.dependsOn].join(" ") + (s.aggregation === "SUM_FRACTION" ? " sum" : "")).join("\n");
}

export function SubtasksForm({ subtasks }: { subtasks: { index: number; points: number; aggregation: string; dependsOn: number[] }[] }) {
  const id = useId();
  const seq = useDraftSeq();
  const { run, pending, error, setError } = useActionRunner();
  const [text, setText] = useState(formatSubtasks(subtasks));
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const rows: { index: number; points: number; aggregation: "MIN" | "SUM_FRACTION"; dependsOn: number[] }[] = [];
        for (const [n, line] of text.split(/\r?\n/).entries()) {
          const words = line.trim().split(/\s+/).filter(Boolean);
          if (words.length === 0) continue;
          const sum = words[words.length - 1] === "sum";
          const nums = (sum ? words.slice(0, -1) : words).map(Number);
          if (nums.length < 2 || nums.some((x) => !Number.isFinite(x))) {
            setError(`Line ${n + 1}: write "number points [depends-on …] [sum]".`);
            return;
          }
          rows.push({ index: nums[0]!, points: nums[1]!, aggregation: sum ? "SUM_FRACTION" : "MIN", dependsOn: nums.slice(2) });
        }
        run(() => setDraftSubtasks({ versionId: seq.versionId, expectedEditSeq: seq.editSeq, subtasks: rows }), {
          success: "Subtasks saved.",
          onSuccess: (d) => seq.setEditSeq(d.editSeq),
        });
      }}
    >
      <Field
        label="Subtask table"
        htmlFor={`${id}-subtasks`}
        hint='One subtask per line: "number points [depends-on …]", optionally ending in "sum" for partial credit. Example: "2 60 1".'
      >
        <Textarea id={`${id}-subtasks`} rows={4} className="font-mono text-sm" value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      <ErrorLine error={error} />
      <Button type="submit" variant="outline" loading={pending}>
        Save subtasks
      </Button>
    </form>
  );
}
