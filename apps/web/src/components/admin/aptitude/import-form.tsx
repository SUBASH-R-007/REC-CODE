"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { Button } from "@recx/design";
import {
  APTITUDE_CSV_COLUMNS,
  APTITUDE_IMPORT_LIMITS,
  APTITUDE_TOPICS,
  APTITUDE_TOPIC_AREA,
  APTITUDE_TOPIC_LABEL,
  LMS_CSV_COLUMNS,
} from "@recx/shared";

/**
 * Uploading an aptitude CSV (Phase 7d).
 *
 * It posts to a ROUTE HANDLER rather than calling a server action, for one
 * concrete reason the copy also tells the operator: a server action's body
 * limit is 1 MB and this file is allowed 4 MB, because a row carries a stem
 * and a mandatory worked explanation.
 *
 * The area and topic pickers exist because an LMS export has neither column.
 * They are the DEFAULT for rows that name no topic — a row that names one
 * wins — and the choice is recorded with the file, because a bank imported
 * under the wrong topic is a weakness heatmap that lies.
 */
export function AptitudeImportForm() {
  const router = useRouter();
  const formId = useId();
  const [topic, setTopic] = useState<string>("");
  const [batch, setBatch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = async (file: File) => {
    setError(null);
    if (file.size > APTITUDE_IMPORT_LIMITS.maxBytes) {
      setError(
        `That file is ${Math.round(file.size / 1024 / 1024)} MB and the limit is ${APTITUDE_IMPORT_LIMITS.maxBytes / 1024 / 1024} MB. Split it — each part imports on its own.`,
      );
      return;
    }
    setBusy(true);
    try {
      const query = new URLSearchParams();
      if (topic) {
        query.set("topic", topic);
        query.set("area", APTITUDE_TOPIC_AREA[topic as keyof typeof APTITUDE_TOPIC_AREA]);
      }
      if (batch.trim()) query.set("batch", batch.trim());
      const response = await fetch(`/api/admin/aptitude/import?${query.toString()}`, {
        method: "POST",
        headers: {
          "content-type": "text/csv",
          "x-recx-file-name": encodeURIComponent(file.name),
        },
        body: await file.arrayBuffer(),
      });
      const body = (await response.json()) as { importId?: string; error?: string };
      if (!response.ok || !body.importId) {
        setError(body.error ?? "The upload did not work.");
        return;
      }
      router.push(`/admin/aptitude/import/${body.importId}`);
    } catch {
      setError("The upload did not reach the server. Check the connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-3 rounded-md border border-border p-4">
        <h2 className="text-sm font-semibold">What the file looks like</h2>
        <p className="text-sm text-text-secondary">
          The columns are the LMS question bank&apos;s own, in its order, so a file exported from there imports here
          unchanged. Options are separated by a pipe, so a comma inside an option needs no quoting, and the correct
          answer is an option number starting at 1 or a letter starting at A.
        </p>
        <p className="font-mono text-xs break-all text-muted">{LMS_CSV_COLUMNS.join(",")}</p>
        <p className="text-sm text-text-secondary">
          Five more columns are optional, for what this product has and the LMS does not. A passage question needs its
          shared text in <code>passage</code>, repeated on every question of the group — the importer makes one passage
          per distinct text.
        </p>
        <p className="font-mono text-xs break-all text-muted">
          {APTITUDE_CSV_COLUMNS.slice(LMS_CSV_COLUMNS.length).join(",")}
        </p>
        <p className="text-sm text-text-secondary">
          Up to {APTITUDE_IMPORT_LIMITS.maxRows} rows and {APTITUDE_IMPORT_LIMITS.maxBytes / 1024 / 1024} MB. One bad
          row never discards the file: every other row still lands, and the next page lists each line with every reason
          it failed.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Topic for rows that name none</span>
          <select
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            aria-describedby={`${formId}-topic`}
            className="h-9 rounded-md border border-border bg-surface px-2"
          >
            <option value="">No default — every row must name its own</option>
            {APTITUDE_TOPICS.map((value) => (
              <option key={value} value={value}>
                {APTITUDE_TOPIC_LABEL[value]}
              </option>
            ))}
          </select>
          <span id={`${formId}-topic`} className="text-xs text-muted">
            An LMS export has no topic column, so this is what its rows get. A row that names its own topic, or carries
            one in its tags, wins. The choice is recorded with the file.
          </span>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Batch label (optional)</span>
          <input
            type="text"
            value={batch}
            maxLength={120}
            onChange={(event) => setBatch(event.target.value)}
            className="h-9 rounded-md border border-border bg-surface px-3"
            placeholder="2026 verbal bank, from the English department"
          />
        </label>
      </div>

      <label className="flex flex-col gap-2 text-sm">
        <span className="font-medium">The file</span>
        <input
          type="file"
          accept=".csv,text/csv"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
          }}
          className="rounded-md border border-border bg-surface p-3"
        />
      </label>

      {busy ? (
        <p role="status" className="text-sm text-text-secondary">
          Importing. A file this size takes a few seconds, and the result page lists every line.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-md border border-danger/30 bg-danger-subtle p-3 text-sm text-danger">
          {error}
        </p>
      ) : null}

      <Button type="button" variant="secondary" size="sm" onClick={() => router.push("/admin/aptitude")}>
        Back to the bank
      </Button>
    </div>
  );
}
