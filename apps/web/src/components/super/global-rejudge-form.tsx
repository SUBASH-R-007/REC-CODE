"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";
import { Button, Field, Select, useToast } from "@recx/design";
import type { LanguageKey, Verdict } from "@recx/shared";
import { requestGlobalRejudge } from "@/server/actions/super-judge";
import { ReasonDialog } from "@/components/super/reason-dialog";


/**
 * Request a rejudge of one problem's judged submissions (two-person
 * approval). Optional narrowing: one revision, some languages, some
 * verdicts. The server counts the matching rows and refuses over 25,000.
 */
export function GlobalRejudgeForm({
  problems,
  languages,
  verdicts,
}: {
  problems: Array<{ id: string; label: string; versions: Array<{ id: string; label: string }> }>;
  languages: Array<{ key: string; label: string }>;
  verdicts: string[];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const id = useId();
  const [problemId, setProblemId] = useState(problems[0]?.id ?? "");
  const [versionId, setVersionId] = useState("");
  const [chosenLanguages, setChosenLanguages] = useState<string[]>([]);
  const [chosenVerdicts, setChosenVerdicts] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const problem = problems.find((p) => p.id === problemId);

  const toggle = (list: string[], set: (v: string[]) => void, value: string) =>
    set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

  if (problems.length === 0) return <p className="text-sm text-text-secondary">No problem has judged submissions yet.</p>;

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        setOpen(true);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Problem" htmlFor={`${id}-problem`}>
          <Select
            id={`${id}-problem`}
            value={problemId}
            onChange={(e) => {
              setProblemId(e.target.value);
              setVersionId("");
            }}
          >
            {problems.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Revision" htmlFor={`${id}-version`} hint="Submissions are pinned to the revision they were judged on.">
          <Select id={`${id}-version`} value={versionId} onChange={(e) => setVersionId(e.target.value)}>
            <option value="">Every revision</option>
            {problem?.versions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium">Languages (none ticked = every language)</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {languages.map((l) => (
            <label key={l.key} className="inline-flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={chosenLanguages.includes(l.key)}
                onChange={() => toggle(chosenLanguages, setChosenLanguages, l.key)}
              />
              {l.label}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium">Verdicts (none ticked = every verdict)</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {verdicts.map((v) => (
            <label key={v} className="inline-flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={chosenVerdicts.includes(v)}
                onChange={() => toggle(chosenVerdicts, setChosenVerdicts, v)}
              />
              {v}
            </label>
          ))}
        </div>
      </fieldset>
      <Button type="submit" variant="outline">
        <RotateCcw className="h-4 w-4" aria-hidden />
        Request global rejudge
      </Button>
      {open && (
        <ReasonDialog
          open
          onClose={() => setOpen(false)}
          title="Request a global rejudge"
          confirmLabel="Send for approval"
          description={
            <p>
              A second super-admin must approve within 24 hours. Approved rows go to the REJUDGE lane, which never takes
              more than its share of the judges.
            </p>
          }
          onConfirm={async (reason) => {
            const result = await requestGlobalRejudge({
              problemId,
              problemVersionId: versionId || null,
              languages: chosenLanguages as LanguageKey[],
              verdicts: chosenVerdicts as Verdict[],
              reason,
            });
            if (result.ok) {
              toast(`Request sent: ${result.data.count} submission(s).`, "success");
              router.refresh();
            }
            return result;
          }}
        />
      )}
    </form>
  );
}
