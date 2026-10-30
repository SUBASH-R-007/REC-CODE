"use client";

import { useId, useState } from "react";
import { Button, Field, Input, Select, Textarea } from "@recx/design";
import { SQL_DIALECT, SQL_DIALECT_LABEL, SQL_LIMITS } from "@recx/shared";
import {
  removeStarterCode,
  setDraftChecker,
  setDraftInteractor,
  setDraftHelp,
  updateDraftDetails,
  updateDraftJudging,
  upsertStarterCode,
} from "@/server/actions/admin-problem-content";
import { previewStatement, setProblemTopics } from "@/server/actions/admin-problems";
import { useActionRunner, useDraftSeq } from "./use-action";

/**
 * The editable sections of a DRAFT revision. Each section saves on its own
 * through an audited server action that carries the draft's editSeq; a
 * stale form (someone else saved in between) gets a conflict instead of
 * overwriting their edit. Editors are plain textareas.
 *
 * Accessible names here avoid the words the reference-solution form uses
 * ("Language", "Label", "Source", "Expected verdict"), so each of those
 * names one control on the page.
 */

export interface Option {
  value: string;
  label: string;
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="text-sm text-danger">
      {error}
    </p>
  ) : null;
}

/** Statement typography for the preview (sanitised HTML from the server). */
const PREVIEW_CLASSES = [
  "rounded-xl border border-border bg-background p-4 text-sm leading-relaxed text-text",
  "[&_p]:my-3 [&_h3]:mt-4 [&_h3]:font-semibold [&_code]:font-mono [&_pre]:overflow-x-auto [&_pre]:text-xs",
  "[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5",
].join(" ");

export function DetailsForm({
  title,
  difficulty,
  statementMd,
  constraints,
  origin,
  origins,
}: {
  title: string;
  difficulty: string;
  statementMd: string;
  constraints: string[];
  origin: string;
  origins: readonly Option[];
}) {
  const id = useId();
  const seq = useDraftSeq();
  const { run, pending, error } = useActionRunner();
  const preview = useActionRunner();
  const [statement, setStatement] = useState(statementMd);
  const [html, setHtml] = useState<string | null>(null);

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        run(
          () =>
            updateDraftDetails({
              versionId: seq.versionId,
              expectedEditSeq: seq.editSeq,
              title: String(form.get("title") ?? ""),
              difficulty: String(form.get("difficulty") ?? ""),
              statementMd: statement,
              constraints: String(form.get("constraints") ?? "")
                .split(/\r?\n/)
                .map((l) => l.trim())
                .filter(Boolean),
              origin: String(form.get("origin") ?? ""),
            }),
          { success: "Details saved.", onSuccess: (d) => seq.setEditSeq(d.editSeq) },
        );
      }}
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Title" htmlFor={`${id}-title`} className="sm:col-span-2">
          <Input id={`${id}-title`} name="title" defaultValue={title} required minLength={3} maxLength={120} />
        </Field>
        <Field label="Difficulty" htmlFor={`${id}-difficulty`}>
          <Select id={`${id}-difficulty`} name="difficulty" defaultValue={difficulty}>
            <option value="EASY">Easy</option>
            <option value="MEDIUM">Medium</option>
            <option value="HARD">Hard</option>
          </Select>
        </Field>
      </div>
      <Field label="Statement (Markdown)" htmlFor={`${id}-statement`} hint="Originally authored. Headings start at ###.">
        <Textarea
          id={`${id}-statement`}
          name="statementMd"
          rows={16}
          className="font-mono text-sm"
          value={statement}
          onChange={(e) => setStatement(e.target.value)}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Constraints (one per line)" htmlFor={`${id}-constraints`} className="sm:col-span-2">
          <Textarea id={`${id}-constraints`} name="constraints" rows={4} className="font-mono text-sm" defaultValue={constraints.join("\n")} />
        </Field>
        <Field label="Content origin" htmlFor={`${id}-origin`}>
          <Select id={`${id}-origin`} name="origin" defaultValue={origin}>
            {origins.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <ErrorLine error={error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={pending}>
          Save details
        </Button>
        <Button
          type="button"
          variant="outline"
          loading={preview.pending}
          onClick={() =>
            preview.run(() => previewStatement({ markdown: statement }), { refresh: false, onSuccess: (d) => setHtml(d.html) })
          }
        >
          Preview statement
        </Button>
      </div>
      {html !== null && (
        <section aria-label="Statement preview" className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Preview — as students will see it</p>
          {/* Sanitised on the server by renderMarkdown() — allow-listed tags only. */}
          <div className={PREVIEW_CLASSES} dangerouslySetInnerHTML={{ __html: html }} />
        </section>
      )}
    </form>
  );
}

export function JudgingForm({
  ioMode,
  functionSignatureJson,
  compareMode,
  floatEpsilon,
  scoringMode,
  stopOnFirstFailure,
  timeLimitMs,
  memoryLimitMb,
  compareModes,
  sqlOrdered,
}: {
  ioMode: string;
  functionSignatureJson: string;
  compareMode: string;
  floatEpsilon: number | null;
  scoringMode: string;
  stopOnFirstFailure: boolean;
  timeLimitMs: number;
  memoryLimitMb: number;
  compareModes: readonly Option[];
  /** SQL versions only (Phase 12k); null for every other io mode. */
  sqlOrdered: boolean | null;
}) {
  const id = useId();
  const seq = useDraftSeq();
  const { run, pending, error } = useActionRunner();
  const [mode, setMode] = useState(ioMode);
  const isSql = mode === "SQL";

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        const text = (name: string) => String(form.get(name) ?? "");
        run(
          () =>
            updateDraftJudging({
              versionId: seq.versionId,
              expectedEditSeq: seq.editSeq,
              ioMode: text("ioMode"),
              functionSignature: mode === "FUNCTION" ? text("functionSignature") : "",
              compareMode: text("compareMode"),
              floatEpsilon: text("floatEpsilon").trim() === "" ? null : text("floatEpsilon"),
              scoringMode: text("scoringMode"),
              stopOnFirstFailure: form.get("stopOnFirstFailure") === "on",
              timeLimitMs: text("timeLimitMs"),
              memoryLimitMb: text("memoryLimitMb"),
              ...(isSql ? { sqlOrdered: form.get("sqlOrdered") === "on" } : {}),
            }),
          { success: "Judging settings saved. Validate again before publishing.", onSuccess: (d) => seq.setEditSeq(d.editSeq) },
        );
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Input mode" htmlFor={`${id}-io`}>
          <Select id={`${id}-io`} name="ioMode" value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="STDIN">STDIN — read input, print output</option>
            <option value="FUNCTION">FUNCTION — implement a method</option>
            <option value="SQL">SQL — one query against a dataset</option>
          </Select>
        </Field>
        <Field
          label="Comparator"
          htmlFor={`${id}-compare`}
          hint={
            isSql
              ? "A SQL problem compares result sets; this is ignored."
              : mode === "FUNCTION"
                ? "Set by the comparator in the signature."
                : undefined
          }
        >
          <Select id={`${id}-compare`} name="compareMode" defaultValue={compareMode === "INTERACTIVE" ? "TOKEN" : compareMode}>
            {compareModes.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Float tolerance" htmlFor={`${id}-eps`} hint="FLOAT / FLOAT_TOLERANCE only, e.g. 0.000001.">
          <Input id={`${id}-eps`} name="floatEpsilon" inputMode="decimal" defaultValue={floatEpsilon ?? ""} />
        </Field>
        <Field label="Scoring" htmlFor={`${id}-scoring`}>
          <Select id={`${id}-scoring`} name="scoringMode" defaultValue={scoringMode}>
            <option value="ICPC">ICPC — all tests or nothing</option>
            <option value="PER_TEST">PER_TEST — points per test</option>
            <option value="SUBTASK">SUBTASK — points per subtask</option>
          </Select>
        </Field>
        <Field label="Time limit (ms)" htmlFor={`${id}-tl`}>
          <Input id={`${id}-tl`} name="timeLimitMs" type="number" min={200} max={15000} step={100} defaultValue={timeLimitMs} required />
        </Field>
        <Field label="Memory limit (MB)" htmlFor={`${id}-ml`}>
          <Input id={`${id}-ml`} name="memoryLimitMb" type="number" min={16} max={1024} defaultValue={memoryLimitMb} required />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm text-text">
        <input type="checkbox" name="stopOnFirstFailure" defaultChecked={stopOnFirstFailure} className="h-4 w-4 accent-primary" />
        Stop judging at the first failing test
      </label>
      {isSql && (
        <div className="space-y-2 rounded-xl border border-border bg-background p-3">
          <p className="text-sm text-text-secondary">
            Judged on {SQL_DIALECT_LABEL[SQL_DIALECT]}, one statement per submission, read-only, stopped after{" "}
            {SQL_LIMITS.statementTimeoutMs / 1000} seconds. Each case is a dataset (the test&apos;s input) and the
            expected rows, which the reference query produces when you validate.
          </p>
          <label className="flex items-center gap-2 text-sm text-text">
            <input
              type="checkbox"
              name="sqlOrdered"
              defaultChecked={sqlOrdered ?? true}
              className="h-4 w-4 accent-primary"
            />
            The row order is part of the answer (the question asks for ORDER BY)
          </label>
          <p className="text-xs text-muted">
            Off means the rows are compared as a set. Getting this wrong either fails a correct answer or accepts a
            wrong one, so it is asked rather than guessed.
          </p>
        </div>
      )}
      {mode === "FUNCTION" && (
        <Field label="Function signature (JSON)" htmlFor={`${id}-sig`} hint="Declares the method, its types and the comparator.">
          <Textarea
            id={`${id}-sig`}
            name="functionSignature"
            rows={8}
            className="font-mono text-xs"
            spellCheck={false}
            defaultValue={functionSignatureJson}
          />
        </Field>
      )}
      <ErrorLine error={error} />
      <Button type="submit" loading={pending}>
        Save judging settings
      </Button>
    </form>
  );
}

export function CheckerForm({ checkerSource }: { checkerSource: string | null }) {
  const id = useId();
  const seq = useDraftSeq();
  const { run, pending, error } = useActionRunner();
  const [source, setSource] = useState(checkerSource ?? "");
  const save = (value: string | null) =>
    run(() => setDraftChecker({ versionId: seq.versionId, expectedEditSeq: seq.editSeq, source: value }), {
      success: value === null ? "Checker removed." : "Checker saved.",
      onSuccess: (d) => seq.setEditSeq(d.editSeq),
    });
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        save(source.trim() ? source : null);
      }}
    >
      <Field label="Checker program (testlib C++)" htmlFor={`${id}-checker`} hint="CHECKER / CUSTOM_CHECKER problems only. Compiled against the pinned testlib.">
        <Textarea
          id={`${id}-checker`}
          rows={10}
          className="font-mono text-xs"
          spellCheck={false}
          value={source}
          onChange={(e) => setSource(e.target.value)}
        />
      </Field>
      <ErrorLine error={error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={pending}>
          Save checker
        </Button>
        {checkerSource !== null && (
          <Button type="button" variant="outline" disabled={pending} onClick={() => save(null)}>
            Remove checker
          </Button>
        )}
      </div>
    </form>
  );
}

/**
 * The interactor of an interactive problem (Phase 12l).
 *
 * The checker's form with three differences in the words, because an
 * author reaching this box is deciding something else: this program TALKS
 * to the student's, it decides the verdict by itself, and the cases carry
 * no expected output for it to read.
 */
export function InteractorForm({ interactorSource }: { interactorSource: string | null }) {
  const id = useId();
  const seq = useDraftSeq();
  const { run, pending, error } = useActionRunner();
  const [source, setSource] = useState(interactorSource ?? "");
  const save = (value: string | null) =>
    run(() => setDraftInteractor({ versionId: seq.versionId, expectedEditSeq: seq.editSeq, source: value }), {
      success: value === null ? "Interactor removed." : "Interactor saved.",
      onSuccess: (d) => seq.setEditSeq(d.editSeq),
    });
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        save(source.trim() ? source : null);
      }}
    >
      <Field
        label="Interactor program (testlib C++)"
        htmlFor={`${id}-interactor`}
        hint="Interactive problems only. It runs beside the student's program, talks to it, and exits with the verdict (quitf(_ok) / _wa / _fail). A case's input is its data; there is no expected output."
      >
        <Textarea
          id={`${id}-interactor`}
          rows={12}
          className="font-mono text-xs"
          spellCheck={false}
          value={source}
          onChange={(e) => setSource(e.target.value)}
        />
      </Field>
      <p className="text-xs text-text-secondary">
        Call <code className="font-mono">registerInteraction(argc, argv)</code>, read the case data from{" "}
        <code className="font-mono">inf</code>, read the student&apos;s queries from <code className="font-mono">ouf</code>, and
        flush every reply (<code className="font-mono">std::endl</code>). Two seconds with neither program writing is reported
        to the student as a deadlock.
      </p>
      <ErrorLine error={error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={pending}>
          Save interactor
        </Button>
        {interactorSource !== null && (
          <Button type="button" variant="outline" disabled={pending} onClick={() => save(null)}>
            Remove interactor
          </Button>
        )}
      </div>
    </form>
  );
}

export function StarterCodeForm({ starters, languages }: { starters: { language: string; code: string }[]; languages: readonly Option[] }) {
  const id = useId();
  const seq = useDraftSeq();
  const { run, pending, error } = useActionRunner();
  const [lang, setLang] = useState(starters[0]?.language ?? languages[0]?.value ?? "cpp20");
  const [code, setCode] = useState(starters.find((s) => s.language === lang)?.code ?? "");
  const labelOf = (key: string) => languages.find((l) => l.value === key)?.label ?? key;

  return (
    <div className="space-y-4">
      {starters.length > 0 ? (
        <ul className="flex flex-wrap gap-2 text-sm">
          {starters.map((s) => (
            <li key={s.language} className="inline-flex items-center gap-2 rounded-lg border border-border px-2 py-1">
              <span className="font-mono text-xs">{labelOf(s.language)}</span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Edit the ${labelOf(s.language)} starter`}
                onClick={() => {
                  setLang(s.language);
                  setCode(s.code);
                }}
              >
                Edit
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Remove the ${labelOf(s.language)} starter`}
                disabled={pending}
                onClick={() =>
                  run(() => removeStarterCode({ versionId: seq.versionId, expectedEditSeq: seq.editSeq, language: s.language }), {
                    success: "Starter removed.",
                    onSuccess: (d) => seq.setEditSeq(d.editSeq),
                  })
                }
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-text-secondary">No starter code yet. Students start from an empty editor (FUNCTION problems get a stub from the signature).</p>
      )}
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => upsertStarterCode({ versionId: seq.versionId, expectedEditSeq: seq.editSeq, language: lang, code }), {
            success: "Starter saved.",
            onSuccess: (d) => seq.setEditSeq(d.editSeq),
          });
        }}
      >
        <Field label="Starter code for" htmlFor={`${id}-starter-for`}>
          <Select
            id={`${id}-starter-for`}
            value={lang}
            onChange={(e) => {
              // Load the chosen language's saved starter, so Save never writes another language's code.
              setLang(e.target.value);
              setCode(starters.find((s) => s.language === e.target.value)?.code ?? "");
            }}
          >
            {languages.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Starter code" htmlFor={`${id}-starter`}>
          <Textarea id={`${id}-starter`} rows={8} className="font-mono text-xs" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} />
        </Field>
        <ErrorLine error={error} />
        <Button type="submit" loading={pending}>
          Save starter code
        </Button>
      </form>
    </div>
  );
}

export function HelpForm({ hints, editorialMd }: { hints: string[]; editorialMd: string | null }) {
  const id = useId();
  const seq = useDraftSeq();
  const { run, pending, error } = useActionRunner();
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        run(
          () =>
            setDraftHelp({
              versionId: seq.versionId,
              expectedEditSeq: seq.editSeq,
              hints: [1, 2, 3].map((t) => String(form.get(`hint${t}`) ?? "")),
              editorialMd: String(form.get("editorial") ?? "") || null,
            }),
          { success: "Hints and editorial saved.", onSuccess: (d) => seq.setEditSeq(d.editSeq) },
        );
      }}
    >
      {[1, 2, 3].map((tier) => (
        <Field
          key={tier}
          label={`Hint ${tier}`}
          htmlFor={`${id}-hint${tier}`}
          hint={tier === 1 ? "A nudge." : tier === 2 ? "The key idea." : "A near-solution."}
        >
          <Textarea id={`${id}-hint${tier}`} name={`hint${tier}`} rows={3} defaultValue={hints[tier - 1] ?? ""} />
        </Field>
      ))}
      <Field label="Editorial (Markdown)" htmlFor={`${id}-editorial`}>
        <Textarea id={`${id}-editorial`} name="editorial" rows={10} className="font-mono text-sm" defaultValue={editorialMd ?? ""} />
      </Field>
      <ErrorLine error={error} />
      <Button type="submit" loading={pending}>
        Save hints and editorial
      </Button>
    </form>
  );
}

export function TopicsForm({ problemId, topics, options }: { problemId: string; topics: string[]; options: readonly Option[] }) {
  const { run, pending, error } = useActionRunner();
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        run(() => setProblemTopics({ problemId, topics: form.getAll("topic").map(String) }), { success: "Topics saved." });
      }}
    >
      <fieldset>
        <legend className="mb-2 text-sm font-medium text-text">Topics (one to four, primary first)</legend>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {options.map((o) => (
            <label key={o.value} className="flex items-center gap-2 text-sm text-text">
              <input type="checkbox" name="topic" value={o.value} defaultChecked={topics.includes(o.value)} className="h-4 w-4 accent-primary" />
              {o.label}
            </label>
          ))}
        </div>
      </fieldset>
      <ErrorLine error={error} />
      <Button type="submit" variant="outline" loading={pending}>
        Save topics
      </Button>
    </form>
  );
}
