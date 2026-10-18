"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Field, Input, Select, Textarea } from "@recx/design";
import { createProblem } from "@/server/actions/admin-problems";
import { useActionRunner } from "./use-action";

export interface Option {
  value: string;
  label: string;
}

/** "Loud Echo" → "loud-echo" */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

/**
 * The new-problem form: identity (title, slug, display code), difficulty,
 * input mode, the declared comparator, the statement and the base limits.
 * Plain fields and a plain textarea (no code editor on admin pages).
 * Creates the problem with its draft revision 1 and opens it.
 */
export function CreateProblemForm({
  suggestedDisplayCode,
  compareModes,
  origins,
  defaultMemoryMb,
}: {
  suggestedDisplayCode: string;
  compareModes: readonly Option[];
  origins: readonly Option[];
  defaultMemoryMb: number;
}) {
  const id = useId();
  const router = useRouter();
  const { run, pending, error } = useActionRunner();
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [ioMode, setIoMode] = useState("STDIN");

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        const text = (name: string) => String(form.get(name) ?? "");
        run(
          () =>
            createProblem({
              title: text("title"),
              slug: text("slug"),
              displayCode: text("displayCode"),
              difficulty: text("difficulty") as "EASY",
              ioMode: text("ioMode") as "STDIN",
              compareMode: text("compareMode") as "TOKEN",
              functionSignature: ioMode === "FUNCTION" ? text("functionSignature") : undefined,
              statementMd: text("statementMd"),
              timeLimitMs: Number(text("timeLimitMs")),
              memoryLimitMb: Number(text("memoryLimitMb")),
              origin: text("origin") as "FACULTY",
            }),
          {
            success: "Draft created.",
            refresh: false,
            onSuccess: (data) => router.push(`/admin/problems/${data.problemId}`),
          },
        );
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Title" htmlFor={`${id}-title`}>
          <Input
            id={`${id}-title`}
            name="title"
            required
            minLength={3}
            maxLength={120}
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              if (!slugTouched) setSlug(slugify(e.target.value));
            }}
          />
        </Field>
        <Field label="Slug" htmlFor={`${id}-slug`} hint="Lower-case letters, digits and hyphens. Fixed once created.">
          <Input
            id={`${id}-slug`}
            name="slug"
            required
            maxLength={100}
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value);
              setSlugTouched(true);
            }}
          />
        </Field>
        <Field label="Display code" htmlFor={`${id}-code`} hint="REC- and four digits. Fixed once created.">
          <Input id={`${id}-code`} name="displayCode" required pattern="REC-[0-9]{4}" defaultValue={suggestedDisplayCode} />
        </Field>
        <Field label="Difficulty" htmlFor={`${id}-difficulty`}>
          <Select id={`${id}-difficulty`} name="difficulty" defaultValue="EASY">
            <option value="EASY">Easy</option>
            <option value="MEDIUM">Medium</option>
            <option value="HARD">Hard</option>
          </Select>
        </Field>
        <Field label="Input mode" htmlFor={`${id}-io`} hint="Standard input, or a method the judge calls (FUNCTION).">
          <Select id={`${id}-io`} name="ioMode" value={ioMode} onChange={(e) => setIoMode(e.target.value)}>
            <option value="STDIN">STDIN — read input, print output</option>
            <option value="FUNCTION">FUNCTION — implement a method</option>
          </Select>
        </Field>
        <Field
          label="Comparator"
          htmlFor={`${id}-compare`}
          hint={ioMode === "FUNCTION" ? "For a function problem the comparator in the signature decides." : "How output is compared. Every problem declares one."}
        >
          <Select id={`${id}-compare`} name="compareMode" defaultValue="TOKEN" required>
            {compareModes.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Time limit (ms)" htmlFor={`${id}-tl`} hint="The C++ base limit; 200 ms to 15,000 ms.">
          <Input id={`${id}-tl`} name="timeLimitMs" type="number" inputMode="numeric" min={200} max={15000} step={100} defaultValue={1000} required />
        </Field>
        <Field label="Memory limit (MB)" htmlFor={`${id}-ml`} hint="16 MB to 1,024 MB.">
          <Input id={`${id}-ml`} name="memoryLimitMb" type="number" inputMode="numeric" min={16} max={1024} defaultValue={defaultMemoryMb} required />
        </Field>
        <Field label="Content origin" htmlFor={`${id}-origin`} hint="All content is originally authored; this records by whom.">
          <Select id={`${id}-origin`} name="origin" defaultValue="FACULTY">
            {origins.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {ioMode === "FUNCTION" && (
        <Field
          label="Function signature (JSON)"
          htmlFor={`${id}-sig`}
          hint={
            <code className="break-all">
              {'{"className":"Solution","methodName":"…","params":[{"name":"nums","type":"list<int>"}],"returns":"int","comparator":"EXACT","mutatedParam":null}'}
            </code>
          }
        >
          <Textarea id={`${id}-sig`} name="functionSignature" rows={6} className="font-mono text-xs" spellCheck={false} required />
        </Field>
      )}
      <Field label="Statement (Markdown)" htmlFor={`${id}-statement`} hint="Originally authored. Never copied from another site.">
        <Textarea id={`${id}-statement`} name="statementMd" rows={12} className="font-mono text-sm" />
      </Field>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <Button type="submit" loading={pending}>
        Create draft
      </Button>
    </form>
  );
}
