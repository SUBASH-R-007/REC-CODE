"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Field, Input } from "@recx/design";
import { setExamBrowserVersionFloor } from "@/server/actions/super-settings";

/**
 * The lowest REC Exam Browser version this deployment accepts (Phase 14f).
 *
 * The emergency lever. A build found to have a flaw stops being usable the
 * day it is known, without a redeploy, because the containment check
 * refuses an attestation presenting a lower version
 * (`docs/EXAM-BROWSER.md` §8).
 *
 * It is also the lever that locks a hall out of its exam if it is set
 * above what candidates have installed — so the field starts filled with
 * the current value rather than empty (unlike the SEB keys beside it,
 * which are secrets and must not be printed back), the consequence is
 * written next to the button in the second person, and clearing it is a
 * button of its own rather than a field somebody has to remember to blank
 * while a hall waits.
 */
export function ExamBrowserFloorForm({ current }: { current: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [minVersion, setMinVersion] = useState(current ?? "");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const save = (value: string) => {
    setError(null);
    setDone(null);
    start(async () => {
      const result = await setExamBrowserVersionFloor({ minVersion: value });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMinVersion(result.data.minVersion ?? "");
      setDone(
        result.data.minVersion === null
          ? "Cleared. Any version of REC Exam Browser is accepted from the next request."
          : `Saved. A copy older than ${result.data.minVersion} is refused from the next request, and the candidate is told to install the current build.`,
      );
      router.refresh();
    });
  };

  return (
    <form
      className="space-y-3 rounded-xl border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        save(minVersion);
      }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-display text-sm font-semibold">Lowest accepted version</h3>
        <p className="text-xs">
          <span className={current ? "text-success" : "text-muted"}>
            {current ? `Floor ${current}` : "No floor: any version is accepted"}
          </span>
        </p>
      </div>

      <Field
        label="Minimum version"
        htmlFor="exam-browser-floor"
        hint="Three numbers, like 1.2.0. Leave it empty to accept any version."
      >
        <Input
          id="exam-browser-floor"
          value={minVersion}
          onChange={(event) => setMinVersion(event.target.value)}
          placeholder="1.0.0"
          inputMode="numeric"
          autoComplete="off"
        />
      </Field>

      <p className="text-xs text-text-secondary">
        Raising this refuses every candidate whose installed copy is older, from their next request onwards — including
        candidates part-way through a paper. Set it above what a hall has installed and that hall cannot sit.
      </p>

      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {done ? <p className="text-sm text-success">{done}</p> : null}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save floor"}
        </Button>
        {current ? (
          <Button type="button" variant="secondary" disabled={pending} onClick={() => save("")}>
            Clear the floor
          </Button>
        ) : null}
      </div>
    </form>
  );
}
