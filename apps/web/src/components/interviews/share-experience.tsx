"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Send } from "lucide-react";
import { Button, Card, CardBody, CardHeader, Field, Input, Select, useToast } from "@recx/design";
import {
  INTERVIEW_EARLIEST_YEAR,
  INTERVIEW_LIMITS,
  INTERVIEW_MODES,
  INTERVIEW_MODE_LABEL,
  INTERVIEW_OUTCOMES,
  INTERVIEW_OUTCOME_LABEL,
  INTERVIEW_PREPARATION,
  INTERVIEW_PREPARATION_LABEL,
  INTERVIEW_ROUND_KINDS,
  INTERVIEW_ROUND_LABEL,
  TOPICS,
  TOPIC_LABEL,
  type InterviewMode,
  type InterviewOutcome,
  type InterviewPreparation,
  type InterviewRoundKind,
  type Topic,
} from "@recx/shared";
import { submitInterviewExperience } from "@/server/actions/interviews";

/**
 * "Share your interview" (Phase 12e).
 *
 * Every control here is a checkbox, a select or a number. There is no
 * textarea, and that is the feature: a student in a hurry types things
 * about an interviewer and a question under an NDA that the college would
 * have to answer for, and prose cannot be counted into the "asked at"
 * tags the archive exists to produce.
 *
 * The form says so, once, at the top — rather than relying on a
 * moderator to explain it afterwards to somebody who has already written
 * four paragraphs.
 */
export function ShareExperience({ problems }: { problems: Array<{ id: string; displayCode: string; title: string }> }) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const thisYear = new Date().getFullYear();
  const [companyName, setCompanyName] = useState("");
  const [role, setRole] = useState("");
  const [mode, setMode] = useState<InterviewMode>("ON_CAMPUS");
  const [heldYear, setHeldYear] = useState(String(thisYear));
  const [heldMonth, setHeldMonth] = useState("1");
  const [rounds, setRounds] = useState("3");
  const [longest, setLongest] = useState("");
  const [outcome, setOutcome] = useState<InterviewOutcome>("WAITING");
  const [roundKinds, setRoundKinds] = useState<InterviewRoundKind[]>(["TECHNICAL"]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [preparation, setPreparation] = useState<InterviewPreparation[]>([]);
  const [problemIds, setProblemIds] = useState<string[]>([]);

  if (!open) {
    return (
      <Button variant="outline" className="min-h-11" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" aria-hidden />
        Share an interview you sat
      </Button>
    );
  }

  const years = Array.from({ length: thisYear - INTERVIEW_EARLIEST_YEAR + 1 }, (_, i) => thisYear - i);

  return (
    <Card>
      <CardHeader
        title="Share an interview you sat"
        subtitle="Fields only, no writing. A TA reads it before it appears, and your name is never shown."
      />
      <CardBody>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            startTransition(async () => {
              const result = await submitInterviewExperience({
                companyName,
                role,
                mode,
                heldYear: Number(heldYear),
                heldMonth: Number(heldMonth),
                rounds: Number(rounds),
                longestRoundMinutes: longest ? Number(longest) : null,
                outcome,
                roundKinds,
                topics,
                preparation,
                problemIds,
              });
              if (!result.ok) {
                toast(result.error, "error");
                return;
              }
              toast("Sent. A TA will read it before it appears.", "success");
              setOpen(false);
              router.refresh();
            });
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Company" htmlFor="x-company" hint="As they write it themselves.">
              <Input
                id="x-company"
                required
                minLength={INTERVIEW_LIMITS.companyName.min}
                maxLength={INTERVIEW_LIMITS.companyName.max}
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
              />
            </Field>
            <Field label="Role" htmlFor="x-role" hint="Software Engineer, Analyst, and so on.">
              <Input id="x-role" required minLength={2} maxLength={80} value={role} onChange={(e) => setRole(e.target.value)} />
            </Field>
            <Field label="How you got it" htmlFor="x-mode">
              <Select id="x-mode" value={mode} onChange={(e) => setMode(e.target.value as InterviewMode)}>
                {INTERVIEW_MODES.map((value) => (
                  <option key={value} value={value}>
                    {INTERVIEW_MODE_LABEL[value]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="How it ended" htmlFor="x-outcome">
              <Select id="x-outcome" value={outcome} onChange={(e) => setOutcome(e.target.value as InterviewOutcome)}>
                {INTERVIEW_OUTCOMES.map((value) => (
                  <option key={value} value={value}>
                    {INTERVIEW_OUTCOME_LABEL[value]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Month" htmlFor="x-month" hint="Month only — a date is identifying.">
              <Select id="x-month" value={heldMonth} onChange={(e) => setHeldMonth(e.target.value)}>
                {["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"].map(
                  (name, index) => (
                    <option key={name} value={index + 1}>
                      {name}
                    </option>
                  ),
                )}
              </Select>
            </Field>
            <Field label="Year" htmlFor="x-year">
              <Select id="x-year" value={heldYear} onChange={(e) => setHeldYear(e.target.value)}>
                {years.map((year) => (
                  <option key={year} value={year}>
                    {year}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="How many rounds" htmlFor="x-rounds">
              <Input
                id="x-rounds"
                type="number"
                required
                min={INTERVIEW_LIMITS.rounds.min}
                max={INTERVIEW_LIMITS.rounds.max}
                value={rounds}
                onChange={(e) => setRounds(e.target.value)}
              />
            </Field>
            <Field label="Longest round, in minutes" htmlFor="x-longest" hint="Optional.">
              <Input
                id="x-longest"
                type="number"
                min={INTERVIEW_LIMITS.durationMinutes.min}
                max={INTERVIEW_LIMITS.durationMinutes.max}
                value={longest}
                onChange={(e) => setLongest(e.target.value)}
              />
            </Field>
          </div>

          <CheckGroup
            legend="What the rounds were"
            options={INTERVIEW_ROUND_KINDS.map((value) => [value, INTERVIEW_ROUND_LABEL[value]] as const)}
            selected={roundKinds}
            onToggle={(value) => setRoundKinds(toggle(roundKinds, value))}
          />
          <CheckGroup
            legend="Topics they asked about"
            options={TOPICS.map((value) => [value, TOPIC_LABEL[value]] as const)}
            selected={topics}
            onToggle={(value) => setTopics(toggle(topics, value))}
          />
          <CheckGroup
            legend="What helped you prepare"
            options={INTERVIEW_PREPARATION.map((value) => [value, INTERVIEW_PREPARATION_LABEL[value]] as const)}
            selected={preparation}
            onToggle={(value) => setPreparation(toggle(preparation, value))}
          />

          <Field
            label="Problems from this site that came up"
            htmlFor="x-problems"
            hint={`Optional, up to ${INTERVIEW_LIMITS.problems.max}. This is what becomes an "asked at" tag, so only pick ones you actually recognised.`}
          >
            <select
              id="x-problems"
              multiple
              size={8}
              className="w-full rounded-xl border border-border bg-surface p-2 text-sm"
              value={problemIds}
              onChange={(e) => setProblemIds([...e.target.selectedOptions].map((option) => option.value).slice(0, INTERVIEW_LIMITS.problems.max))}
            >
              {problems.map((problem) => (
                <option key={problem.id} value={problem.id}>
                  {problem.displayCode} — {problem.title}
                </option>
              ))}
            </select>
          </Field>

          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" className="min-h-11" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" className="min-h-11" loading={pending}>
              <Send className="h-4 w-4" aria-hidden />
              Send it to a TA
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

function CheckGroup<T extends string>({
  legend,
  options,
  selected,
  onToggle,
}: {
  legend: string;
  options: ReadonlyArray<readonly [T, string]>;
  selected: T[];
  onToggle: (value: T) => void;
}) {
  return (
    <fieldset>
      <legend className="text-sm font-medium">{legend}</legend>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
        {options.map(([value, label]) => (
          <label key={value} className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-border"
              checked={selected.includes(value)}
              onChange={() => onToggle(value)}
            />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
