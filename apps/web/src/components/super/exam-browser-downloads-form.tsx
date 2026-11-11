"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@recx/design";
import { setExamBrowserDownloads } from "@/server/actions/super-settings";

/**
 * Whether `/exam-browser` hands out the installer (Phase 14i).
 *
 * One switch, and what it governs is the DOWNLOAD rather than the button:
 * the route reads the setting on every request, so turning it off takes
 * the file away from anybody who kept the link. That is worth saying on
 * the screen, because a switch that only hid a link would be worth very
 * little and would look identical here.
 *
 * It also shows what is actually on the disk, because "on" and "working"
 * are different states and the gap between them is where a hall finds out
 * the morning of a paper. A deployment can have the switch on with no
 * directory configured, or a directory with no build in it; both say so.
 */
export type DownloadsStatus =
  | { readonly kind: "ready"; readonly version: string; readonly builds: number }
  | { readonly kind: "not_configured" }
  | { readonly kind: "no_build" };

export function ExamBrowserDownloadsForm({ enabled, status }: { enabled: boolean; status: DownloadsStatus }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const toggle = (next: boolean) => {
    setError(null);
    setDone(null);
    start(async () => {
      const result = await setExamBrowserDownloads({ enabled: next });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDone(
        result.data.enabled
          ? "On. /exam-browser offers the installer, to anybody with the link — the page is public."
          : "Off. The download is refused from the next request, including for anybody who kept the link.",
      );
      router.refresh();
    });
  };

  return (
    <div className="space-y-3 rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-display text-sm font-semibold">Hand out the installer</h3>
        <p className="text-xs">
          <span className={enabled ? "text-success" : "text-muted"}>{enabled ? "On" : "Off"}</span>
        </p>
      </div>

      <p className="text-sm text-text-secondary">
        With this on, <span className="font-mono">/exam-browser</span> offers the installer for each platform a build
        has been published for. The page is public and so is the download, deliberately: a candidate setting up a
        laptop the evening before has often not signed in on it, and an installer behind a sign-in is one they fetch
        from somewhere else instead.
      </p>

      {status.kind === "ready" ? (
        <p className="text-xs text-text-secondary">
          Version {status.version} is published, for {status.builds} platform{status.builds === 1 ? "" : "s"}.
        </p>
      ) : status.kind === "not_configured" ? (
        <p className="text-xs text-warning">
          No installer directory is configured on this deployment (<span className="font-mono">
            EXAM_BROWSER_DOWNLOAD_DIR
          </span>), so nothing would be offered even with this on. See{" "}
          <span className="font-mono">deploy/exam-browser/README.md</span>.
        </p>
      ) : (
        <p className="text-xs text-warning">
          The directory is configured but holds no build the manifest names, so nothing would be offered even with
          this on.
        </p>
      )}

      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {done ? <p className="text-sm text-success">{done}</p> : null}

      <div className="flex flex-wrap gap-2">
        {enabled ? (
          <Button type="button" variant="secondary" disabled={pending} onClick={() => toggle(false)}>
            {pending ? "Saving…" : "Stop handing it out"}
          </Button>
        ) : (
          <Button type="button" disabled={pending} onClick={() => toggle(true)}>
            {pending ? "Saving…" : "Hand it out"}
          </Button>
        )}
      </div>
    </div>
  );
}
