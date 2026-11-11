"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Send, Wand2 } from "lucide-react";
import { Button, Field, Input, Textarea, useToast } from "@recx/design";
import {
  ACCOMMODATION_KINDS,
  ACCOMMODATION_KIND_LABELS,
  ACCOMMODATION_LIMITS,
  PROCTOR_EVENT_KINDS,
  PROCTOR_EVENT_LABELS,
  suggestedExemptSignals,
  type AccommodationKind,
  type ProctorEventKind,
} from "@recx/shared";
import { requestAccommodation } from "@/server/actions/admin-accommodations";

export interface AccommodationFormInitial {
  kinds: AccommodationKind[];
  exemptSignals: ProctorEventKind[];
  extraTimePercent: number;
  extraTimeMinutes: number;
  allowBreaks: boolean;
  breakMinutes: number;
  fontScalePercent: number;
  allowScribe: boolean;
  highContrast: boolean;
  /** yyyy-MM-dd */
  validUntil: string;
}

const toggle = <T,>(list: T[], value: T, on: boolean) => (on ? [...new Set([...list, value])] : list.filter((v) => v !== value));

/**
 * Request an accommodation for one student (or a change to their current
 * one, which replaces it when approved). A SUPER_ADMIN may approve at once.
 * The kinds are a disability label: they are kept on the accommodation
 * itself and never written to the audit log.
 */
export function AccommodationForm({
  userId,
  studentName,
  supersedesId,
  initial,
  canApproveNow,
  minDate,
  maxDate,
}: {
  userId: string;
  studentName: string;
  supersedesId: string | null;
  initial: AccommodationFormInitial;
  canApproveNow: boolean;
  minDate: string;
  maxDate: string;
}) {
  const id = useId();
  const router = useRouter();
  const { toast } = useToast();
  const [t, setT] = useState(initial);
  const [reason, setReason] = useState("");
  const [approveNow, setApproveNow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const num = (key: "extraTimePercent" | "extraTimeMinutes" | "breakMinutes" | "fontScalePercent") =>
    (e: React.ChangeEvent<HTMLInputElement>) => setT((s) => ({ ...s, [key]: e.target.value === "" ? 0 : Number(e.target.value) }));
  const L = ACCOMMODATION_LIMITS;

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const result = await requestAccommodation({
            userId,
            supersedesId: supersedesId ?? undefined,
            approveNow: canApproveNow && approveNow,
            reason,
            terms: { ...t, validUntil: new Date(`${t.validUntil}T23:59:59+05:30`) },
          });
          if (!result.ok) {
            setError(result.error);
            return;
          }
          toast(result.data.status === "APPROVED" ? "Approved." : "Requested. A super-admin decides it.", "success");
          router.push(`/admin/accommodations/${result.data.id}`);
        });
      }}
    >
      <fieldset>
        <legend className="mb-2 text-sm font-medium text-text">Accommodations for {studentName}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {ACCOMMODATION_KINDS.map((kind) => (
            <label key={kind} className="flex min-h-10 items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={t.kinds.includes(kind)}
                onChange={(e) => {
                  const on = e.target.checked;
                  setT((s) => ({
                    ...s,
                    kinds: toggle(s.kinds, kind, on),
                    ...(kind === "BREAKS" ? { allowBreaks: on, breakMinutes: on ? s.breakMinutes : 0 } : {}),
                  }));
                }}
              />
              {ACCOMMODATION_KIND_LABELS[kind]}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-medium text-text">Time</legend>
        <Field label="Extra time (percent)" htmlFor={`${id}-pct`} hint={`${L.extraTimePercent.min}–${L.extraTimePercent.max}. 33% ≈ 20 minutes per hour.`}>
          <Input
            id={`${id}-pct`}
            type="number"
            inputMode="numeric"
            min={L.extraTimePercent.min}
            max={L.extraTimePercent.max}
            value={t.extraTimePercent}
            onChange={num("extraTimePercent")}
            className="tabular-nums"
          />
        </Field>
        <Field label="Extra time (minutes)" htmlFor={`${id}-min`} hint={`${L.extraTimeMinutes.min}–${L.extraTimeMinutes.max}, added after the percentage.`}>
          <Input
            id={`${id}-min`}
            type="number"
            inputMode="numeric"
            min={L.extraTimeMinutes.min}
            max={L.extraTimeMinutes.max}
            value={t.extraTimeMinutes}
            onChange={num("extraTimeMinutes")}
            className="tabular-nums"
          />
        </Field>
        <Field label="Break minutes" htmlFor={`${id}-brk`} hint="Only with “Rest breaks”.">
          <Input
            id={`${id}-brk`}
            type="number"
            inputMode="numeric"
            min={L.breakMinutes.min}
            max={L.breakMinutes.max}
            value={t.breakMinutes}
            disabled={!t.allowBreaks}
            onChange={num("breakMinutes")}
            className="tabular-nums"
          />
        </Field>
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-medium text-text">Display and support</legend>
        <Field label="Text size (percent)" htmlFor={`${id}-font`} hint={`${L.fontScalePercent.min}–${L.fontScalePercent.max}.`}>
          <Input
            id={`${id}-font`}
            type="number"
            inputMode="numeric"
            min={L.fontScalePercent.min}
            max={L.fontScalePercent.max}
            value={t.fontScalePercent}
            onChange={num("fontScalePercent")}
            className="tabular-nums"
          />
        </Field>
        <div className="space-y-1 pt-6">
          <label className="flex min-h-10 items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4 accent-primary" checked={t.allowScribe} onChange={(e) => setT((s) => ({ ...s, allowScribe: e.target.checked }))} />
            A scribe may type for the student
          </label>
          <label className="flex min-h-10 items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4 accent-primary" checked={t.highContrast} onChange={(e) => setT((s) => ({ ...s, highContrast: e.target.checked }))} />
            High-contrast display
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-1 text-sm font-medium text-text">Proctoring signals to discount</legend>
        <p className="mb-2 text-xs text-text-secondary">
          Reviewers see only this list, never the accommodation itself. Signals are evidence for a person, never a penalty.
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setT((s) => ({ ...s, exemptSignals: [...new Set([...s.exemptSignals, ...suggestedExemptSignals(s.kinds)])] }))}
        >
          <Wand2 className="h-3.5 w-3.5" aria-hidden />
          Add the suggested signals for the chosen accommodations
        </Button>
        <div className="mt-2 grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
          {PROCTOR_EVENT_KINDS.map((signal) => (
            <label key={signal} className="flex min-h-9 items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={t.exemptSignals.includes(signal)}
                onChange={(e) => setT((s) => ({ ...s, exemptSignals: toggle(s.exemptSignals, signal, e.target.checked) }))}
              />
              {PROCTOR_EVENT_LABELS[signal]}
            </label>
          ))}
        </div>
      </fieldset>

      <Field label="Valid until" htmlFor={`${id}-until`} hint={`At most ${L.maxValidityDays} days ahead.`}>
        <Input
          id={`${id}-until`}
          type="date"
          min={minDate}
          max={maxDate}
          value={t.validUntil}
          onChange={(e) => setT((s) => ({ ...s, validUntil: e.target.value }))}
          required
          className="tabular-nums sm:w-56"
        />
      </Field>

      <Field
        label="Reason"
        htmlFor={`${id}-reason`}
        hint="Kept with the accommodation for staff only; never shown to reviewers or written to the audit log. Supporting documents stay with the accessibility office."
        error={error}
      >
        <Textarea
          id={`${id}-reason`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          minLength={10}
          maxLength={2000}
          rows={4}
          aria-invalid={error ? true : undefined}
        />
      </Field>

      {canApproveNow ? (
        <label className="flex min-h-10 items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4 accent-primary" checked={approveNow} onChange={(e) => setApproveNow(e.target.checked)} />
          Approve now (super-admin)
        </label>
      ) : null}

      <Button type="submit" loading={pending}>
        {!pending && <Send className="h-4 w-4" aria-hidden />}
        {canApproveNow && approveNow ? "Approve" : supersedesId ? "Request this change" : "Request"}
      </Button>
    </form>
  );
}
