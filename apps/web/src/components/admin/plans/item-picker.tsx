"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ListPlus } from "lucide-react";
import { Button, Field, Select, Textarea, useToast } from "@recx/design";
import { addPlanItems } from "@/server/actions/admin-plans";

/**
 * Add published problems to a section by display code ("REC-0001, REC-0004").
 * Up to 50 at a time; codes already in the plan and codes that are not
 * published are reported, not errors.
 */
export function ItemPicker({
  planId,
  sections,
  disabled,
}: {
  planId: string;
  sections: { id: string; title: string }[];
  disabled: boolean;
}) {
  const id = useId();
  const router = useRouter();
  const { toast } = useToast();
  const [sectionId, setSectionId] = useState(sections[0]?.id ?? "");
  const [codes, setCodes] = useState("");
  const [report, setReport] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (sections.length === 0) {
    return <p className="text-sm text-text-secondary">Add a section first; problems are added to a section.</p>;
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        setReport(null);
        const problemCodes = codes
          .split(/[\s,;]+/)
          .map((c) => c.trim())
          .filter(Boolean);
        start(async () => {
          const result = await addPlanItems({ planId, sectionId: sectionId || sections[0]!.id, problemCodes });
          if (!result.ok) {
            setError(result.error);
            return;
          }
          const r = result.data;
          const parts = [
            r.added.length ? `Added ${r.added.join(", ")}.` : "Nothing was added.",
            r.alreadyInPlan.length ? `Already in this plan: ${r.alreadyInPlan.join(", ")}.` : "",
            r.unavailable.length ? `Not published or unknown: ${r.unavailable.join(", ")}.` : "",
          ].filter(Boolean);
          setReport(parts.join(" "));
          if (r.added.length) {
            toast(`Added ${r.added.length} ${r.added.length === 1 ? "problem" : "problems"}.`, "success");
            setCodes("");
          }
          router.refresh();
        });
      }}
    >
      <fieldset disabled={disabled} className="space-y-3">
        <legend className="sr-only">Add problems</legend>
        <Field label="Section" htmlFor={`${id}-section`}>
          <Select id={`${id}-section`} value={sectionId} onChange={(e) => setSectionId(e.target.value)}>
            {sections.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Problem codes"
          htmlFor={`${id}-codes`}
          hint="Separate codes with commas, spaces or new lines. Only published problems can be added."
          error={error}
        >
          <Textarea
            id={`${id}-codes`}
            value={codes}
            onChange={(e) => setCodes(e.target.value)}
            rows={3}
            required
            spellCheck={false}
            className="font-mono"
            aria-invalid={error ? true : undefined}
          />
        </Field>
        <Button type="submit" loading={pending}>
          {!pending && <ListPlus className="h-4 w-4" aria-hidden />}
          Add problems
        </Button>
      </fieldset>
      {report ? (
        <p role="status" className="text-sm text-text-secondary">
          {report}
        </p>
      ) : null}
    </form>
  );
}
