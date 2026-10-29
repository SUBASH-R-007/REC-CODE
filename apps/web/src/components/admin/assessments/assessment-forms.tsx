"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarPlus, ListPlus, Play, Plus, Trash2 } from "lucide-react";
import { ASSESSMENT_PROCTOR_MODES, FOCUS_LIMIT_ACTIONS } from "@recx/shared";
import { Button, Field, Input, useToast } from "@recx/design";
import {
  addAssessmentProblem,
  createAssessment,
  removeAssessmentProblem,
  scheduleExamSession,
  setAssessmentStatus,
} from "@/server/actions/admin-assessments";

/**
 * The assessment admin's forms (Phase 12a).
 *
 * The proctor mode is a required choice with no default and no "none"
 * option, which is the point: an assessment is always proctored, and the
 * person creating one decides how closely rather than inheriting it.
 */

const MODE_LABEL: Record<string, string> = {
  ADVISORY: "Advisory — watched and recorded, sat anywhere",
  REMOTE_MONITORED: "Remote monitored — a registered device, sat anywhere",
  KIOSK_SEB: "Kiosk (Safe Exam Browser) — the kiosk build, verified per request",
  LAB_SUPERVISED: "Lab supervised — a college hall, on the hall's network",
};

function Problem({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="rounded-xl border border-danger/25 bg-danger-subtle px-3.5 py-2.5 text-sm text-danger">
      {error}
    </p>
  );
}

export function CreateAssessmentForm() {
  const router = useRouter();
  const { toast } = useToast();
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<string>("LAB_SUPERVISED");
  const [placement, setPlacement] = useState(false);
  const [pending, start] = useTransition();

  return (
    <form
      className="space-y-4"
      action={(data) =>
        start(async () => {
          setError(null);
          const result = await createAssessment({
            slug: String(data.get("slug") ?? ""),
            title: String(data.get("title") ?? ""),
            instructions: String(data.get("instructions") ?? ""),
            proctorMode: mode,
            affectsPlacementEligibility: placement,
            opensAt: String(data.get("opensAt") ?? ""),
            closesAt: String(data.get("closesAt") ?? ""),
            durationMinutes: String(data.get("durationMinutes") ?? ""),
            maxAttempts: String(data.get("maxAttempts") ?? "1"),
            maxFocusWarnings: String(data.get("maxFocusWarnings") ?? "3"),
            onLimit: String(data.get("onLimit") ?? "AUTOSUBMIT") as (typeof FOCUS_LIMIT_ACTIONS)[number],
            strictMode: data.get("strictMode") === "on",
            audienceBatchYear: String(data.get("audienceBatchYear") ?? "") || null,
            audienceDepartmentCode: String(data.get("audienceDepartmentCode") ?? "") || null,
            audienceSection: String(data.get("audienceSection") ?? "") || null,
          });
          if (!result.ok) {
            setError(result.error);
            return;
          }
          toast("The assessment is a draft. Add its questions next.", "success");
          router.push(`/admin/assessments/${result.data.id}`);
        })
      }
    >
      <Problem error={error} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Title" htmlFor="title">
          <Input id="title" name="title" required maxLength={160} />
        </Field>
        <Field label="Address" htmlFor="slug" hint="Lower-case words joined by hyphens, e.g. cse-2027-midsem.">
          <Input id="slug" name="slug" required maxLength={80} spellCheck={false} />
        </Field>
      </div>

      <Field label="Instructions" htmlFor="instructions" hint="Markdown. Candidates read this before the clock starts.">
        <textarea
          id="instructions"
          name="instructions"
          required
          rows={4}
          maxLength={20_000}
          className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        />
      </Field>

      <fieldset className="rounded-xl border border-border bg-elevated p-4">
        <legend className="px-1 text-sm font-semibold text-text">How closely it is watched</legend>
        <p className="mb-3 text-xs text-text-secondary">
          An assessment is always proctored — a contest or a practice problem is the place for a sitting nobody
          watches. Only a lab-supervised result may ever feed placement eligibility.
        </p>
        <div className="space-y-2">
          {ASSESSMENT_PROCTOR_MODES.map((value) => (
            <label key={value} className="flex items-start gap-2 text-sm text-text">
              <input
                type="radio"
                name="proctorMode"
                value={value}
                checked={mode === value}
                onChange={() => {
                  setMode(value);
                  if (value !== "LAB_SUPERVISED") setPlacement(false);
                }}
                className="mt-1"
              />
              <span>{MODE_LABEL[value] ?? value}</span>
            </label>
          ))}
        </div>
        <label className="mt-4 flex items-start gap-2 text-sm text-text">
          <input
            type="checkbox"
            name="affectsPlacementEligibility"
            checked={placement}
            disabled={mode !== "LAB_SUPERVISED"}
            onChange={(event) => setPlacement(event.target.checked)}
            className="mt-1"
          />
          <span>
            This result may count towards placement eligibility
            {mode !== "LAB_SUPERVISED" ? " (lab-supervised only)" : ""}
          </span>
        </label>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Opens" htmlFor="opensAt" hint="Campus time (IST).">
          <Input id="opensAt" name="opensAt" type="datetime-local" required />
        </Field>
        <Field label="Closes" htmlFor="closesAt">
          <Input id="closesAt" name="closesAt" type="datetime-local" required />
        </Field>
        <Field label="Duration (minutes)" htmlFor="durationMinutes" hint="1 to 360.">
          <Input id="durationMinutes" name="durationMinutes" inputMode="numeric" defaultValue="60" required />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Attempts allowed" htmlFor="maxAttempts">
          <Input id="maxAttempts" name="maxAttempts" inputMode="numeric" defaultValue="1" />
        </Field>
        <Field label="Focus warnings" htmlFor="maxFocusWarnings" hint="Before the limit action.">
          <Input id="maxFocusWarnings" name="maxFocusWarnings" inputMode="numeric" defaultValue="3" />
        </Field>
        <Field label="At the limit" htmlFor="onLimit" hint="Neither voids a result.">
          <select
            id="onLimit"
            name="onLimit"
            defaultValue="AUTOSUBMIT"
            className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <option value="AUTOSUBMIT">Submit what they have</option>
            <option value="FLAG_ONLY">Flag it for a reviewer</option>
          </select>
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Batch (optional)" htmlFor="audienceBatchYear">
          <Input id="audienceBatchYear" name="audienceBatchYear" inputMode="numeric" placeholder="2027" />
        </Field>
        <Field label="Department (optional)" htmlFor="audienceDepartmentCode">
          <Input id="audienceDepartmentCode" name="audienceDepartmentCode" maxLength={16} placeholder="CSE" />
        </Field>
        <Field label="Section (optional)" htmlFor="audienceSection" hint="Needs a batch and a department.">
          <Input id="audienceSection" name="audienceSection" maxLength={4} placeholder="A" />
        </Field>
      </div>

      <label className="flex items-start gap-2 text-sm text-text">
        <input type="checkbox" name="strictMode" className="mt-1" />
        <span>Strict mode (full screen required throughout)</span>
      </label>

      <Button type="submit" loading={pending}>
        {!pending && <Plus className="h-4 w-4" aria-hidden />}
        Create the draft
      </Button>
    </form>
  );
}

export function AddQuestionForm({ assessmentId, nextPosition }: { assessmentId: string; nextPosition: number }) {
  const router = useRouter();
  const { toast } = useToast();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <form
      className="flex flex-wrap items-end gap-3"
      action={(data) =>
        start(async () => {
          setError(null);
          const result = await addAssessmentProblem({
            assessmentId,
            problemSlug: String(data.get("problemSlug") ?? ""),
            position: String(data.get("position") ?? ""),
            points: String(data.get("points") ?? "1"),
          });
          if (!result.ok) {
            setError(result.error);
            return;
          }
          toast(`Question ${result.data.position} pinned at revision ${result.data.revision}.`, "success");
          router.refresh();
        })
      }
    >
      <Field label="Position" htmlFor="position" className="w-24">
        <Input id="position" name="position" inputMode="numeric" defaultValue={String(nextPosition)} required />
      </Field>
      <Field label="Problem address" htmlFor="problemSlug" className="w-64">
        <Input id="problemSlug" name="problemSlug" required autoComplete="off" spellCheck={false} />
      </Field>
      <Field label="Points" htmlFor="points" className="w-24">
        <Input id="points" name="points" inputMode="numeric" defaultValue="1" />
      </Field>
      <Button type="submit" loading={pending}>
        {!pending && <ListPlus className="h-4 w-4" aria-hidden />}
        Add
      </Button>
      {error ? <p role="alert" className="w-full text-sm text-danger">{error}</p> : null}
    </form>
  );
}

export function RemoveQuestionButton({ assessmentProblemId }: { assessmentProblemId: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="outline"
      loading={pending}
      onClick={() =>
        start(async () => {
          const result = await removeAssessmentProblem({ assessmentProblemId });
          toast(result.ok ? `Question ${result.data.position} removed.` : result.error, result.ok ? "success" : "error");
          router.refresh();
        })
      }
    >
      {!pending && <Trash2 className="h-3.5 w-3.5" aria-hidden />}
      Remove
    </Button>
  );
}

export function ScheduleHallForm({ assessmentId, needsAllowlist }: { assessmentId: string; needsAllowlist: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <form
      className="space-y-3"
      action={(data) =>
        start(async () => {
          setError(null);
          const cidrs = String(data.get("allowedCidrs") ?? "")
            .split(/[\s,]+/)
            .map((s) => s.trim())
            .filter(Boolean);
          const result = await scheduleExamSession({
            assessmentId,
            label: String(data.get("label") ?? ""),
            room: String(data.get("room") ?? "") || null,
            startsAt: String(data.get("startsAt") ?? ""),
            endsAt: String(data.get("endsAt") ?? ""),
            capacity: String(data.get("capacity") ?? "60"),
            allowedCidrs: cidrs,
          });
          if (!result.ok) {
            setError(result.error);
            return;
          }
          toast(`${result.data.label} scheduled.`, "success");
          router.refresh();
        })
      }
    >
      <Problem error={error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Label" htmlFor="label" hint="What the invigilator calls it.">
          <Input id="label" name="label" required maxLength={80} placeholder="Lab 3, morning" />
        </Field>
        <Field label="Room (optional)" htmlFor="room">
          <Input id="room" name="room" maxLength={80} placeholder="AB1-304" />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Opens" htmlFor="sessionStartsAt">
          <Input id="sessionStartsAt" name="startsAt" type="datetime-local" required />
        </Field>
        <Field label="Closes" htmlFor="sessionEndsAt">
          <Input id="sessionEndsAt" name="endsAt" type="datetime-local" required />
        </Field>
        <Field label="Seats" htmlFor="capacity">
          <Input id="capacity" name="capacity" inputMode="numeric" defaultValue="60" />
        </Field>
      </div>
      <Field
        label={needsAllowlist ? "Allowed networks (required)" : "Allowed networks (optional)"}
        htmlFor="allowedCidrs"
        hint={
          needsAllowlist
            ? "CIDR blocks, one per line or comma-separated. For a lab sitting this allowlist IS the enforcement: a machine that leaves the hall network is refused on its next heartbeat."
            : "CIDR blocks, one per line. Leave blank to accept any network."
        }
      >
        <textarea
          id="allowedCidrs"
          name="allowedCidrs"
          rows={2}
          placeholder="10.21.0.0/16"
          className="w-full rounded-xl border border-border bg-surface px-3 py-2 font-mono text-xs text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        />
      </Field>
      <Button type="submit" loading={pending}>
        {!pending && <CalendarPlus className="h-4 w-4" aria-hidden />}
        Schedule the hall
      </Button>
    </form>
  );
}

export function StatusButtons({ assessmentId, status }: { assessmentId: string; status: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const NEXT: Record<string, Array<{ to: string; label: string }>> = {
    DRAFT: [{ to: "PUBLISHED", label: "Publish (the terms stop being editable)" }],
    PUBLISHED: [{ to: "OPEN", label: "Open it for candidates" }],
    OPEN: [{ to: "CLOSED", label: "Close it" }],
    CLOSED: [{ to: "ARCHIVED", label: "Archive it" }],
    ARCHIVED: [],
  };

  const moves = NEXT[status] ?? [];
  if (moves.length === 0) return <p className="text-sm text-text-secondary">This assessment is finished.</p>;

  return (
    <div className="space-y-2">
      <Problem error={error} />
      <div className="flex flex-wrap gap-2">
        {moves.map((move) => (
          <Button
            key={move.to}
            loading={pending}
            onClick={() =>
              start(async () => {
                setError(null);
                const result = await setAssessmentStatus({ assessmentId, to: move.to as "OPEN" });
                if (!result.ok) {
                  setError(result.error);
                  return;
                }
                toast(`Now ${result.data.status}.`, "success");
                router.refresh();
              })
            }
          >
            {!pending && <Play className="h-4 w-4" aria-hidden />}
            {move.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
