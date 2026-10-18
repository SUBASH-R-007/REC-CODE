"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Field, Input, Select, Textarea, useToast } from "@recx/design";
import {
  addContestProblem,
  createContest,
  publishContest,
  removeContestProblem,
} from "@/server/actions/admin-contests";

/**
 * Contest authoring forms. Leaf client components: every rule they appear to
 * apply is actually applied by the server action (and by the database), so a
 * form that is bypassed changes nothing.
 */

const KINDS = [
  ["ICPC", "ICPC — one point per problem, 20-minute penalties"],
  ["SUBTASK", "Subtask — partial credit, no penalty"],
] as const;

/** `datetime-local` wants "YYYY-MM-DDTHH:mm" in local time. */
function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function CreateContestForm({ canGoCollegeWide }: { canGoCollegeWide: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<"PUBLIC" | "COHORT">(canGoCollegeWide ? "PUBLIC" : "COHORT");
  const { toast } = useToast();
  const router = useRouter();

  const inTwoHours = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const andTwoMore = new Date(inTwoHours.getTime() + 2 * 60 * 60 * 1000);

  return (
    <form
      className="mt-6 grid max-w-2xl gap-4"
      action={(formData) =>
        start(async () => {
          setError(null);
          const result = await createContest({
            slug: String(formData.get("slug") ?? ""),
            title: String(formData.get("title") ?? ""),
            rules: String(formData.get("rules") ?? ""),
            kind: String(formData.get("kind") ?? "ICPC") as "ICPC" | "SUBTASK",
            startsAt: String(formData.get("startsAt") ?? ""),
            endsAt: String(formData.get("endsAt") ?? ""),
            freezeMinutes: String(formData.get("freezeMinutes") ?? "0"),
            isRated: formData.get("isRated") === "on",
            visibility,
            audienceBatchYear: formData.get("audienceBatchYear")
              ? String(formData.get("audienceBatchYear"))
              : null,
            audienceDepartmentCode: formData.get("audienceDepartmentCode")
              ? String(formData.get("audienceDepartmentCode"))
              : null,
          });
          if (result.ok) {
            toast("Contest created as a draft. Add its problems next.", "success");
            router.push(`/admin/contests/${result.data.id}`);
          } else {
            setError(result.error);
          }
        })
      }
    >
      <Field label="Title" htmlFor="title">
        <Input id="title" name="title" required maxLength={120} autoComplete="off" />
      </Field>
      <Field label="Address" htmlFor="slug" hint="Lower-case words joined by hyphens, e.g. div2-round-7.">
        <Input id="slug" name="slug" required maxLength={80} autoComplete="off" />
      </Field>
      <Field label="Scoring" htmlFor="kind">
        <Select id="kind" name="kind" defaultValue="ICPC">
          {KINDS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Starts" htmlFor="startsAt">
          <Input id="startsAt" name="startsAt" type="datetime-local" required defaultValue={toLocalInput(inTwoHours)} />
        </Field>
        <Field label="Ends" htmlFor="endsAt">
          <Input id="endsAt" name="endsAt" type="datetime-local" required defaultValue={toLocalInput(andTwoMore)} />
        </Field>
      </div>
      <Field
        label="Standings freeze (minutes)"
        htmlFor="freezeMinutes"
        hint="0 for no freeze. A freeze needs a contest of at least 90 minutes."
      >
        <Input id="freezeMinutes" name="freezeMinutes" inputMode="numeric" defaultValue="30" />
      </Field>
      <Field label="Audience" htmlFor="visibility">
        <Select
          id="visibility"
          name="visibility"
          value={visibility}
          onChange={(e) => setVisibility(e.target.value as "PUBLIC" | "COHORT")}
        >
          {canGoCollegeWide ? <option value="PUBLIC">The whole college</option> : null}
          <option value="COHORT">One cohort</option>
        </Select>
      </Field>
      {visibility === "COHORT" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Batch" htmlFor="audienceBatchYear" hint="Leave blank for every batch.">
            <Input id="audienceBatchYear" name="audienceBatchYear" inputMode="numeric" autoComplete="off" />
          </Field>
          <Field label="Department" htmlFor="audienceDepartmentCode" hint="Leave blank for every department.">
            <Input id="audienceDepartmentCode" name="audienceDepartmentCode" autoComplete="off" />
          </Field>
        </div>
      ) : null}
      <label className="flex items-center gap-2 text-sm text-text">
        <input type="checkbox" name="isRated" defaultChecked />
        Rated — but only if at least 30 students take part
      </label>
      <Field label="Rules" htmlFor="rules" hint="Markdown. Students read this before they start.">
        <Textarea id="rules" name="rules" required rows={8} maxLength={20_000} />
      </Field>

      {error ? (
        <p role="alert" className="rounded-xl border border-danger/40 bg-danger-subtle px-3 py-2 text-sm text-text">
          {error}
        </p>
      ) : null}
      <div>
        <Button type="submit" loading={pending}>
          Create draft
        </Button>
      </div>
    </form>
  );
}

export function AddProblemForm({ contestId, kind }: { contestId: string; kind: "ICPC" | "SUBTASK" }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();
  const router = useRouter();

  return (
    <form
      className="mt-4 flex flex-wrap items-end gap-3"
      action={(formData) =>
        start(async () => {
          setError(null);
          const result = await addContestProblem({
            contestId,
            problemSlug: String(formData.get("problemSlug") ?? ""),
            index: String(formData.get("index") ?? "").toUpperCase(),
            points: String(formData.get("points") ?? "1"),
          });
          if (result.ok) {
            toast(`Added ${result.data.index} at revision ${result.data.revision}.`, "success");
            router.refresh();
          } else {
            setError(result.error);
          }
        })
      }
    >
      <Field label="Letter" htmlFor="index" className="w-24">
        <Input id="index" name="index" required maxLength={2} autoComplete="off" />
      </Field>
      <Field label="Problem address" htmlFor="problemSlug" className="w-64">
        <Input id="problemSlug" name="problemSlug" required autoComplete="off" />
      </Field>
      <Field label={kind === "SUBTASK" ? "Points" : "Points (1)"} htmlFor="points" className="w-28">
        <Input id="points" name="points" inputMode="numeric" defaultValue={kind === "SUBTASK" ? "100" : "1"} />
      </Field>
      <Button type="submit" loading={pending}>
        Add problem
      </Button>
      {error ? (
        <p role="alert" className="w-full text-sm text-danger">
          {error}
        </p>
      ) : null}
    </form>
  );
}

export function RemoveProblemButton({ contestProblemId, index }: { contestProblemId: string; index: string }) {
  const [pending, start] = useTransition();
  const { toast } = useToast();
  const router = useRouter();

  return (
    <Button
      size="sm"
      variant="outline"
      loading={pending}
      aria-label={`Remove problem ${index}`}
      onClick={() =>
        start(async () => {
          const result = await removeContestProblem({ contestProblemId });
          if (result.ok) {
            toast(`Removed ${result.data.index}.`, "success");
            router.refresh();
          } else {
            toast(result.error, "error");
          }
        })
      }
    >
      Remove
    </Button>
  );
}

export function PublishContestButton({ contestId }: { contestId: string }) {
  const [pending, start] = useTransition();
  const { toast } = useToast();
  const router = useRouter();

  return (
    <Button
      loading={pending}
      onClick={() =>
        start(async () => {
          const result = await publishContest({ contestId });
          if (result.ok) {
            toast("Published. Students can register now.", "success");
            router.refresh();
          } else {
            toast(result.error, "error");
          }
        })
      }
    >
      Publish
    </Button>
  );
}
