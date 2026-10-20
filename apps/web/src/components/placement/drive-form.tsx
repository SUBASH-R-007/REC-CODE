"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Field, Input, Select, Textarea } from "@recx/design";
import { READINESS_TIERS, READINESS_TIER_LABEL } from "@recx/shared";
import { createDrive } from "@/server/actions/placement-drives";

/**
 * Adding a drive (Phase 9f).
 *
 * The threshold field says "% of what was measurable" in its own label, not
 * in a footnote. That is the correction the design's review found: with
 * `mockInterviewScore` permanently unsourced no TOP score can exceed 85, so a
 * bar typed as a raw 70 would exclude a cohort for a component nobody has
 * built. Labelling the unit at the point of entry is the only place it
 * reliably lands.
 *
 * There is no "auto-mark eligible above the bar" option, and there never will
 * be. SPEC §5: eligibility is a human decision recorded with its reason.
 */
export function DriveForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    companyName: "",
    tier: "PRODUCT" as (typeof READINESS_TIERS)[number],
    driveOn: "",
    thresholdScore: "",
    eligibleBatchYear: "",
    departments: "",
    notes: "",
  });

  const set = (key: keyof typeof form) => (value: string) => setForm((f) => ({ ...f, [key]: value }));

  const submit = () => {
    setError(null);
    if (form.companyName.trim().length < 2) {
      setError("Give the company's name.");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.driveOn)) {
      setError("Give the drive date as yyyy-MM-dd.");
      return;
    }
    start(async () => {
      const result = await createDrive({
        companyName: form.companyName.trim(),
        tier: form.tier,
        driveOn: form.driveOn,
        thresholdScore: form.thresholdScore === "" ? null : Number(form.thresholdScore),
        eligibleBatchYear: form.eligibleBatchYear === "" ? null : Number(form.eligibleBatchYear),
        eligibleDepartmentCodes: form.departments
          .split(",")
          .map((code) => code.trim())
          .filter(Boolean),
        notes: form.notes.trim(),
      });
      if (!result.ok) setError(result.error);
      else router.push(`/placement-cell/drives/${result.data.driveId}`);
    });
  };

  return (
    <div className="max-w-xl space-y-4">
      <Field label="Company" htmlFor="drive-company">
        <Input
          id="drive-company"
          value={form.companyName}
          onChange={(event) => set("companyName")(event.target.value)}
          maxLength={120}
        />
      </Field>

      <Field label="Tier they recruit at" htmlFor="drive-tier">
        <Select id="drive-tier" value={form.tier} onChange={(event) => set("tier")(event.target.value)}>
          {READINESS_TIERS.map((tier) => (
            <option key={tier} value={tier}>
              {READINESS_TIER_LABEL[tier]}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Drive date" htmlFor="drive-on" hint="yyyy-MM-dd">
        <Input id="drive-on" type="date" value={form.driveOn} onChange={(event) => set("driveOn")(event.target.value)} />
      </Field>

      <Field
        label="Readiness bar, as a % of what was measurable"
        htmlFor="drive-threshold"
        hint="Optional. A percentage of each student's own measurable weight, never of 100 — leave it empty for a drive with no readiness bar."
      >
        <Input
          id="drive-threshold"
          type="number"
          min={0}
          max={100}
          value={form.thresholdScore}
          onChange={(event) => set("thresholdScore")(event.target.value)}
        />
      </Field>

      <Field label="Batch" htmlFor="drive-batch" hint="Optional. Empty means every batch.">
        <Input
          id="drive-batch"
          type="number"
          min={1900}
          max={2200}
          value={form.eligibleBatchYear}
          onChange={(event) => set("eligibleBatchYear")(event.target.value)}
        />
      </Field>

      <Field
        label="Departments"
        htmlFor="drive-departments"
        hint="Optional, comma separated (CSE, ECE). Empty means every department."
      >
        <Input
          id="drive-departments"
          value={form.departments}
          onChange={(event) => set("departments")(event.target.value)}
        />
      </Field>

      <Field label="Notes" htmlFor="drive-notes" error={error}>
        <Textarea
          id="drive-notes"
          rows={3}
          maxLength={2000}
          value={form.notes}
          onChange={(event) => set("notes")(event.target.value)}
        />
      </Field>

      <Button onClick={submit} disabled={pending}>
        {pending ? "Adding…" : "Add the drive"}
      </Button>
    </div>
  );
}
