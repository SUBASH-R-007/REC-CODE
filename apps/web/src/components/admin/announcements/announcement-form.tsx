"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Save } from "lucide-react";
import { Button, Field, Input, Textarea, useToast } from "@recx/design";
import { saveAnnouncementDraft } from "@/server/actions/admin-announcements";

export interface AnnouncementFormValues {
  title: string;
  body: string;
  tone: "INFO" | "IMPORTANT";
  link: string;
  batchYear: string;
  departmentCode: string;
  section: string;
  /** datetime-local, IST. */
  endsAt: string;
}

/** "2026-10-17T18:00" in IST → an ISO instant. */
function istToIso(local: string): string {
  return new Date(`${local}:00+05:30`).toISOString();
}

/**
 * Write or edit an announcement draft. Plain text; the link must be a path
 * on this site. The audience must lie inside your scope. Publishing is a
 * separate step on the announcement's page.
 */
export function AnnouncementForm({ id, initial }: { id?: string; initial: AnnouncementFormValues }) {
  const fid = useId();
  const router = useRouter();
  const { toast } = useToast();
  const [v, setV] = useState<AnnouncementFormValues>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = (key: keyof AnnouncementFormValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setV((s) => ({ ...s, [key]: e.target.value }));

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const result = await saveAnnouncementDraft({
            id,
            title: v.title,
            body: v.body,
            tone: v.tone,
            link: v.link,
            audience: { batchYear: v.batchYear, departmentCode: v.departmentCode, section: v.section },
            endsAt: new Date(v.endsAt ? istToIso(v.endsAt) : Number.NaN),
          });
          if (!result.ok) {
            setError(result.error);
            return;
          }
          toast("Draft saved.", "success");
          if (!id) router.push(`/admin/announcements/${result.data.id}`);
          else router.refresh();
        });
      }}
    >
      <Field label="Title" htmlFor={`${fid}-title`}>
        <Input id={`${fid}-title`} value={v.title} onChange={set("title")} required maxLength={120} />
      </Field>
      <Field label="Message" htmlFor={`${fid}-body`} hint="Plain text, up to 2,000 characters. Line breaks are kept.">
        <Textarea id={`${fid}-body`} value={v.body} onChange={set("body")} required maxLength={2000} rows={6} />
      </Field>

      <fieldset>
        <legend className="mb-1.5 text-sm font-medium text-text">Tone</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          {(
            [
              ["INFO", "Information"],
              ["IMPORTANT", "Important (marked “Important” on the banner)"],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="inline-flex min-h-10 items-center gap-2">
              <input
                type="radio"
                name={`${fid}-tone`}
                value={value}
                checked={v.tone === value}
                onChange={() => setV((s) => ({ ...s, tone: value }))}
                className="h-4 w-4 accent-primary"
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>

      <Field label="Link (optional)" htmlFor={`${fid}-link`} hint="A path on this site, e.g. /sheets/rec-starter-sheet.">
        <Input id={`${fid}-link`} value={v.link} onChange={set("link")} maxLength={512} spellCheck={false} className="font-mono" />
      </Field>

      <fieldset className="rounded-xl border border-border p-4">
        <legend className="px-1 text-sm font-medium text-text">Audience</legend>
        <p className="mb-3 text-xs text-text-secondary">Leave a field empty for every value. A section needs a batch and a department.</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Batch" htmlFor={`${fid}-batch`}>
            <Input
              id={`${fid}-batch`}
              value={v.batchYear}
              onChange={set("batchYear")}
              inputMode="numeric"
              maxLength={4}
              placeholder="Every batch"
              className="tabular-nums"
            />
          </Field>
          <Field label="Department" htmlFor={`${fid}-dept`}>
            <Input id={`${fid}-dept`} value={v.departmentCode} onChange={set("departmentCode")} maxLength={10} placeholder="Every department" />
          </Field>
          <Field label="Section" htmlFor={`${fid}-section`}>
            <Input id={`${fid}-section`} value={v.section} onChange={set("section")} maxLength={4} placeholder="Every section" />
          </Field>
        </div>
      </fieldset>

      <Field label="Show the banner until (IST)" htmlFor={`${fid}-ends`} hint="At most 30 days ahead. Notifications stay in history after this." error={error}>
        <Input id={`${fid}-ends`} type="datetime-local" value={v.endsAt} onChange={set("endsAt")} required className="tabular-nums" />
      </Field>

      <Button type="submit" loading={pending}>
        {!pending && <Save className="h-4 w-4" aria-hidden />}
        Save draft
      </Button>
    </form>
  );
}
