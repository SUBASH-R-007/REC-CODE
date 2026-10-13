"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { Button, Dialog, Field, Input, Select, useToast } from "@recx/design";
import type { ActionResult } from "@/lib/errors";
import {
  addPlanSection,
  deletePlanSection,
  movePlanItem,
  movePlanSection,
  removePlanItem,
  renamePlanSection,
} from "@/server/actions/admin-plans";
import type { AdminPlanSection } from "@/server/queries/admin-plans";

/** Run an action, report the outcome, refresh the server-rendered page. */
function useRunner() {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<ActionResult<unknown>>, done?: string) =>
    start(async () => {
      const result = await fn();
      if (!result.ok) toast(result.error, "error");
      else {
        if (done) toast(done, "success");
        router.refresh();
      }
    });
  return { pending, run };
}

function RenameSection({ section, disabled }: { section: AdminPlanSection; disabled: boolean }) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(section.title);
  const { pending, run } = useRunner();
  if (!editing) {
    return (
      <Button variant="ghost" size="sm" disabled={disabled} onClick={() => setEditing(true)}>
        <Pencil className="h-3.5 w-3.5" aria-hidden />
        Rename<span className="sr-only"> section {section.title}</span>
      </Button>
    );
  }
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => renamePlanSection({ sectionId: section.id, title }), "Section renamed.");
        setEditing(false);
      }}
    >
      <div>
        <label htmlFor={`${id}-t`} className="sr-only">
          New title for {section.title}
        </label>
        <Input id={`${id}-t`} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} required className="h-8 py-1" />
      </div>
      <Button type="submit" size="sm" loading={pending}>
        <Check className="h-3.5 w-3.5" aria-hidden />
        Save
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
        <X className="h-3.5 w-3.5" aria-hidden />
        Cancel
      </Button>
    </form>
  );
}

function ConfirmDelete({ section, disabled }: { section: AdminPlanSection; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const { pending, run } = useRunner();
  return (
    <>
      <Button variant="ghost" size="sm" disabled={disabled} onClick={() => setOpen(true)}>
        <Trash2 className="h-3.5 w-3.5" aria-hidden />
        Delete<span className="sr-only"> section {section.title}</span>
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`Delete “${section.title}”?`} size="sm">
        <p className="text-sm text-text-secondary">
          The section and its {section.items.length} {section.items.length === 1 ? "problem" : "problems"} leave the plan.
          Students keep their solves; enrolment counts are recalculated.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={pending}
            onClick={() => {
              run(() => deletePlanSection({ sectionId: section.id }), "Section deleted.");
              setOpen(false);
            }}
          >
            Delete section
          </Button>
        </div>
      </Dialog>
    </>
  );
}

/**
 * Sections and their problems: rename, reorder and delete sections; move a
 * problem up, down or to another section; remove it. Disabled while the
 * plan is seed-managed (the server refuses as well).
 */
export function SectionEditor({
  planId,
  sections,
  disabled,
}: {
  planId: string;
  sections: AdminPlanSection[];
  disabled: boolean;
}) {
  const id = useId();
  const [newTitle, setNewTitle] = useState("");
  const { pending, run } = useRunner();

  return (
    <div className="space-y-5">
      {sections.length === 0 ? (
        <p className="text-sm text-text-secondary">No sections yet. Add one, then add problems to it.</p>
      ) : null}
      {sections.map((section, si) => (
        <section key={section.id} aria-labelledby={`${id}-s-${section.id}`} className="rounded-xl border border-border">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
            <h3 id={`${id}-s-${section.id}`} className="font-display text-sm font-semibold">
              {si + 1}. {section.title}{" "}
              <span className="font-normal text-text-secondary">
                ({section.items.length} {section.items.length === 1 ? "problem" : "problems"})
              </span>
            </h3>
            <div className="flex flex-wrap items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled || si === 0 || pending}
                onClick={() => run(() => movePlanSection({ sectionId: section.id, direction: "up" }))}
              >
                <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                Up<span className="sr-only"> section {section.title}</span>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled || si === sections.length - 1 || pending}
                onClick={() => run(() => movePlanSection({ sectionId: section.id, direction: "down" }))}
              >
                <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                Down<span className="sr-only"> section {section.title}</span>
              </Button>
              <RenameSection section={section} disabled={disabled} />
              <ConfirmDelete section={section} disabled={disabled} />
            </div>
          </div>
          {section.items.length === 0 ? (
            <p className="px-4 py-3 text-sm text-text-secondary">No problems in this section yet.</p>
          ) : (
            <ol className="divide-y divide-border">
              {section.items.map((item, ii) => (
                <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                  <span className="min-w-0">
                    <span className="font-mono text-xs text-text-secondary">{item.displayCode}</span>{" "}
                    <span className="font-medium">{item.title}</span>
                    {item.status !== "PUBLISHED" ? (
                      <span className="ml-2 text-xs text-warning">({item.status.toLowerCase()}; hidden from students)</span>
                    ) : null}
                  </span>
                  <span className="flex flex-wrap items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={disabled || ii === 0 || pending}
                      onClick={() => run(() => movePlanItem({ itemId: item.id, sectionId: section.id, position: ii - 1 }))}
                    >
                      <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                      <span className="sr-only">Move {item.displayCode} up</span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={disabled || ii === section.items.length - 1 || pending}
                      onClick={() => run(() => movePlanItem({ itemId: item.id, sectionId: section.id, position: ii + 1 }))}
                    >
                      <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                      <span className="sr-only">Move {item.displayCode} down</span>
                    </Button>
                    {sections.length > 1 ? (
                      <>
                        <label htmlFor={`${id}-mv-${item.id}`} className="sr-only">
                          Move {item.displayCode} to section
                        </label>
                        <Select
                          id={`${id}-mv-${item.id}`}
                          className="h-8 w-40 py-1 text-xs"
                          disabled={disabled || pending}
                          value=""
                          onChange={(e) => {
                            const target = e.target.value;
                            if (target) run(() => movePlanItem({ itemId: item.id, sectionId: target, position: 10_000 }), "Moved.");
                          }}
                        >
                          <option value="">Move to…</option>
                          {sections
                            .filter((s) => s.id !== section.id)
                            .map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.title}
                              </option>
                            ))}
                        </Select>
                      </>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={disabled || pending}
                      onClick={() => run(() => removePlanItem({ itemId: item.id }), `${item.displayCode} removed.`)}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      <span className="sr-only">Remove {item.displayCode}</span>
                    </Button>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      ))}

      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => addPlanSection({ planId, title: newTitle }), "Section added.");
          setNewTitle("");
        }}
      >
        <Field label="New section" htmlFor={`${id}-new`} className="w-full sm:w-72">
          <Input id={`${id}-new`} value={newTitle} onChange={(e) => setNewTitle(e.target.value)} maxLength={120} required disabled={disabled} />
        </Field>
        <Button type="submit" variant="outline" disabled={disabled} loading={pending}>
          <Plus className="h-4 w-4" aria-hidden />
          Add section
        </Button>
      </form>
    </div>
  );
}
