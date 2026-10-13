"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";
import { Button, Field, Input } from "@recx/design";

/**
 * Upload a bulk-import zip. The archive goes as the raw request body to
 * POST /api/admin/problems/import (application/zip), which answers 202 with
 * the import id; the import page then follows it row by row.
 */
export function ImportForm({ maxMb }: { maxMb: number }) {
  const id = useId();
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!file) return;
        if (file.size > maxMb * 1024 * 1024) {
          setError(`The archive is larger than ${maxMb} MB.`);
          return;
        }
        setError(null);
        setPending(true);
        try {
          const response = await fetch("/api/admin/problems/import", {
            method: "POST",
            headers: { "content-type": "application/zip", "x-recx-file-name": encodeURIComponent(file.name.slice(0, 200)) },
            body: file,
          });
          const body = (await response.json().catch(() => ({}))) as { importId?: string; error?: string };
          if (response.status === 202 && body.importId) {
            router.push(`/admin/problems/import/${body.importId}`);
            return;
          }
          if (response.status === 409 && body.importId) {
            setError(body.error ?? "Your previous import is still running.");
            router.push(`/admin/problems/import/${body.importId}`);
            return;
          }
          setError(body.error ?? `The upload failed (HTTP ${response.status}).`);
        } catch {
          setError("The upload failed. Check your connection and try again.");
        } finally {
          setPending(false);
        }
      }}
    >
      <Field label="Archive (.zip)" htmlFor={`${id}-file`} hint={`Package format 1 (docs/AUTHORING.md). Up to ${maxMb} MB and 500 problems.`}>
        <Input
          id={`${id}-file`}
          type="file"
          accept=".zip,application/zip"
          required
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </Field>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <Button type="submit" loading={pending} disabled={!file}>
        {!pending && <Upload className="h-4 w-4" aria-hidden />}
        Upload and import
      </Button>
    </form>
  );
}
