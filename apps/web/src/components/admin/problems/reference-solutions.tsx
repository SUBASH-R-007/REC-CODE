"use client";

import { useId, useState } from "react";
import { Button, Field, Input, Select } from "@recx/design";
import { removeReferenceSolution, upsertReferenceSolution } from "@/server/actions/admin-problem-content";
import { useActionRunner, useDraftSeq } from "./use-action";

export interface ReferenceRow {
  id: string;
  language: string;
  label: string | null;
  expectedVerdict: string;
  source: string;
  measuredMs: number | null;
}

interface Option {
  value: string;
  label: string;
}

const EMPTY = { referenceId: null as string | null, language: "cpp20", label: "", expectedVerdict: "AC", source: "" };

/**
 * Reference solutions of a draft: model solutions (expected AC; a C++ one is
 * mandatory) and deliberately-wrong ones (expected WA / TLE / …) that
 * validation must see fail. One form edits one solution at a time, so the
 * page has exactly one "Language", "Expected verdict", "Label" and "Source"
 * control. The source is a plain textarea (no code editor on admin pages).
 */
export function ReferenceSolutions({
  references,
  languages,
  verdicts,
}: {
  references: ReferenceRow[];
  languages: readonly Option[];
  verdicts: readonly Option[];
}) {
  const id = useId();
  const seq = useDraftSeq();
  const { run, pending, error } = useActionRunner();
  const [form, setForm] = useState(EMPTY);
  const labelOf = (key: string) => languages.find((l) => l.value === key)?.label ?? key;

  return (
    <div className="space-y-5">
      {references.length > 0 ? (
        <div role="region" tabIndex={0} aria-label="Reference solutions" className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[32rem] text-sm">
            <caption className="sr-only">Reference solutions of this revision</caption>
            <thead className="bg-primary-subtle/40 text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th scope="col" className="px-3 py-2">
                  Solution
                </th>
                <th scope="col" className="px-3 py-2">
                  Language
                </th>
                <th scope="col" className="px-3 py-2">
                  Expected
                </th>
                <th scope="col" className="px-3 py-2">
                  Measured
                </th>
                <th scope="col" className="px-3 py-2">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {references.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="px-3 py-2">{r.label ?? "Unlabelled"}</td>
                  <td className="px-3 py-2 font-mono text-xs">{labelOf(r.language)}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.expectedVerdict}</td>
                  <td className="px-3 py-2 tabular-nums">{r.measuredMs === null ? "—" : `${r.measuredMs} ms`}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap justify-end gap-1">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        aria-label={`Edit ${r.label ?? "solution"} (${r.language})`}
                        onClick={() =>
                          setForm({
                            referenceId: r.id,
                            language: r.language,
                            label: r.label ?? "",
                            expectedVerdict: r.expectedVerdict,
                            source: r.source,
                          })
                        }
                      >
                        Edit
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        aria-label={`Remove ${r.label ?? "solution"} (${r.language})`}
                        disabled={pending}
                        onClick={() =>
                          run(
                            () => removeReferenceSolution({ versionId: seq.versionId, expectedEditSeq: seq.editSeq, referenceId: r.id }),
                            {
                              success: "Reference solution removed.",
                              onSuccess: (d) => {
                                seq.setEditSeq(d.editSeq);
                                if (form.referenceId === r.id) setForm(EMPTY);
                              },
                            },
                          )
                        }
                      >
                        Remove
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-text-secondary">No reference solutions yet. Add a C++ model solution first.</p>
      )}

      <form
        className="space-y-4 rounded-xl border border-border p-4"
        onSubmit={(e) => {
          e.preventDefault();
          run(
            () =>
              upsertReferenceSolution({
                versionId: seq.versionId,
                expectedEditSeq: seq.editSeq,
                ...(form.referenceId ? { referenceId: form.referenceId } : {}),
                language: form.language,
                label: form.label,
                expectedVerdict: form.expectedVerdict,
                source: form.source,
              }),
            {
              success: form.referenceId ? "Reference solution updated. Validate again." : "Reference solution added.",
              onSuccess: (d) => {
                seq.setEditSeq(d.editSeq);
                setForm(EMPTY);
              },
            },
          );
        }}
      >
        <p className="text-sm font-medium text-text">
          {form.referenceId ? "Editing a reference solution" : "Add a reference solution"}
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Language" htmlFor={`${id}-lang`}>
            <Select id={`${id}-lang`} value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })}>
              {languages.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Expected verdict" htmlFor={`${id}-verdict`}>
            <Select id={`${id}-verdict`} value={form.expectedVerdict} onChange={(e) => setForm({ ...form, expectedVerdict: e.target.value })}>
              {verdicts.map((v) => (
                <option key={v.value} value={v.value}>
                  {v.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Label" htmlFor={`${id}-label`} hint="e.g. Model, Brute force">
            <Input id={`${id}-label`} value={form.label} maxLength={80} required onChange={(e) => setForm({ ...form, label: e.target.value })} />
          </Field>
        </div>
        <Field label="Source" htmlFor={`${id}-source`}>
          <textarea
            id={`${id}-source`}
            value={form.source}
            onChange={(e) => setForm({ ...form, source: e.target.value })}
            rows={14}
            required
            spellCheck={false}
            className="min-h-24 w-full resize-y rounded-xl border border-border-strong bg-surface px-3.5 py-2.5 font-mono text-xs text-text focus:border-primary"
          />
        </Field>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" loading={pending}>
            Save reference solution
          </Button>
          {form.referenceId && (
            <Button type="button" variant="outline" onClick={() => setForm(EMPTY)}>
              Cancel editing
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
