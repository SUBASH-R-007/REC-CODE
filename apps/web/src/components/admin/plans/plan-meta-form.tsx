"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Save } from "lucide-react";
import { Button, Field, Input, Textarea, useToast } from "@recx/design";
import { createStudyPlan, updateStudyPlan } from "@/server/actions/admin-plans";

interface Values {
  slug: string;
  title: string;
  description: string;
  sortOrder: string;
}

/**
 * Create a plan (kind fixed by the route) or edit its title, description and
 * order. The slug is chosen once: it is part of every student's link.
 */
export function PlanMetaForm({
  mode,
  kind,
  planId,
  initial,
  disabled,
  noun,
}: {
  mode: "create" | "edit";
  kind: "SHEET" | "TRACK";
  planId?: string;
  initial?: Partial<Values>;
  disabled?: boolean;
  noun: string;
}) {
  const id = useId();
  const router = useRouter();
  const { toast } = useToast();
  const [values, setValues] = useState<Values>({
    slug: initial?.slug ?? "",
    title: initial?.title ?? "",
    description: initial?.description ?? "",
    sortOrder: initial?.sortOrder ?? "0",
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = (key: keyof Values) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const result =
            mode === "create"
              ? await createStudyPlan({
                  kind,
                  slug: values.slug,
                  title: values.title,
                  description: values.description,
                  sortOrder: Number(values.sortOrder),
                })
              : await updateStudyPlan({
                  planId: planId ?? "",
                  title: values.title,
                  description: values.description,
                  sortOrder: Number(values.sortOrder),
                });
          if (!result.ok) {
            setError(result.error);
            return;
          }
          toast(mode === "create" ? `The ${noun} was created.` : "Saved.", "success");
          router.refresh();
        });
      }}
    >
      <fieldset disabled={disabled} className="space-y-4">
        <legend className="sr-only">{mode === "create" ? `New ${noun}` : `${noun} details`}</legend>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Slug"
            htmlFor={`${id}-slug`}
            hint={mode === "create" ? "Lower-case letters, digits and hyphens. It cannot change later." : "The slug cannot change."}
            className="sm:col-span-2"
          >
            <Input
              id={`${id}-slug`}
              value={values.slug}
              onChange={set("slug")}
              readOnly={mode === "edit"}
              required
              maxLength={80}
              spellCheck={false}
              autoComplete="off"
              className="font-mono"
            />
          </Field>
          <Field label="Order" htmlFor={`${id}-order`} hint="Lower numbers are listed first.">
            <Input
              id={`${id}-order`}
              type="number"
              inputMode="numeric"
              min={0}
              max={10_000}
              value={values.sortOrder}
              onChange={set("sortOrder")}
              className="tabular-nums"
            />
          </Field>
        </div>
        <Field label="Title" htmlFor={`${id}-title`}>
          <Input id={`${id}-title`} value={values.title} onChange={set("title")} required minLength={3} maxLength={120} />
        </Field>
        <Field label="Description" htmlFor={`${id}-description`} hint="Shown to students on the index and the plan page." error={error}>
          <Textarea
            id={`${id}-description`}
            value={values.description}
            onChange={set("description")}
            required
            minLength={10}
            maxLength={2000}
            rows={4}
            aria-invalid={error ? true : undefined}
          />
        </Field>
        <Button type="submit" loading={pending}>
          {!pending && <Save className="h-4 w-4" aria-hidden />}
          {mode === "create" ? `Create ${noun}` : "Save details"}
        </Button>
      </fieldset>
    </form>
  );
}
