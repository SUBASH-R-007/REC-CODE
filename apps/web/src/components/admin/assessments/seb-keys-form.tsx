"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Field, Input } from "@recx/design";
import { setSebKeys } from "@/server/actions/admin-assessments";

/**
 * The Safe Exam Browser keys for a hall, or for the college (Phase 12z).
 *
 * The last link in the kiosk chain. 12y.8 generates the `.seb` file and
 * the readiness page hands it to SEB; SEB then sends
 * `sha256(url + key)` on every request, and the server compares it against
 * the pair saved here. Until this form the pair lived in a
 * `PlatformSetting` row with no screen, so a kiosk paper refused every
 * candidate with "no exam keys have been configured" and the only cure was
 * a hand-written SQL statement.
 *
 * The boxes start EMPTY even when a key is saved, and the state is
 * reported beside them instead. A key is a 64-character digest nobody
 * reads; printing it back into an input invites a half-edit, and showing
 * "set" or "not set" is the only thing a person actually needs to know.
 */
export function SebKeysForm({
  examSessionId,
  label,
  configKeySet,
  browserExamKeySet,
}: {
  examSessionId: string;
  label: string;
  configKeySet: boolean;
  browserExamKeySet: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [configKey, setConfigKey] = useState("");
  const [browserExamKey, setBrowserExamKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const id = examSessionId;

  const save = () => {
    setError(null);
    setDone(null);
    start(async () => {
      const result = await setSebKeys({ examSessionId, configKey, browserExamKey });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setConfigKey("");
      setBrowserExamKey("");
      setDone(
        result.data.configKey || result.data.browserExamKey
          ? "Saved. Candidates in Safe Exam Browser are verified against this from the next request."
          : "Cleared. This scope now has no keys, so a kiosk paper here refuses every candidate until one is set.",
      );
      router.refresh();
    });
  };

  return (
    <form
      className="space-y-3 rounded-xl border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-display text-sm font-semibold">{label}</h3>
        <p className="text-xs">
          <span className={configKeySet ? "text-success" : "text-muted"}>
            Config key {configKeySet ? "set" : "not set"}
          </span>
          {" · "}
          <span className={browserExamKeySet ? "text-success" : "text-muted"}>
            Browser exam key {browserExamKeySet ? "set" : "not set"}
          </span>
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Config key"
          htmlFor={`seb-config-${id}`}
          hint="From SEB Config Tool, for the .seb file this paper hands out."
        >
          <Input
            id={`seb-config-${id}`}
            value={configKey}
            onChange={(event) => setConfigKey(event.target.value)}
            placeholder={configKeySet ? "set — type to replace, or clear below" : "64 hex characters"}
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-xs"
          />
        </Field>
        <Field
          label="Browser exam key"
          htmlFor={`seb-browser-${id}`}
          hint="Optional. Identifies the SEB build as well as the file."
        >
          <Input
            id={`seb-browser-${id}`}
            value={browserExamKey}
            onChange={(event) => setBrowserExamKey(event.target.value)}
            placeholder={browserExamKeySet ? "set — type to replace, or clear below" : "64 hex characters"}
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-xs"
          />
        </Field>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {done ? (
        <p role="status" className="text-sm text-success">
          {done}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={pending} disabled={configKey.trim() === "" && browserExamKey.trim() === ""}>
          Save these keys
        </Button>
        {configKeySet || browserExamKeySet ? (
          <Button
            type="button"
            variant="outline"
            loading={pending}
            onClick={() => {
              setConfigKey("");
              setBrowserExamKey("");
              save();
            }}
          >
            Clear
          </Button>
        ) : null}
      </div>

      <p className="text-xs text-muted">
        Both boxes empty saves nothing; use Clear to remove what is stored. Saving is recorded against your name at
        SECURITY level — the record says whether a key was set, never which.
      </p>
    </form>
  );
}
