"use client";

import { FlaskConical, RefreshCw, Rocket } from "lucide-react";
import { Button } from "@recx/design";
import { publishProblemVersion, refreshValidation, startProblemValidation } from "@/server/actions/admin-problems";
import { useActionRunner } from "./use-action";

/**
 * Validation and publish controls of one revision. Publish carries the
 * Problem.version the page was rendered with (expectedProblemVersion), so a
 * stale page can never publish over a newer revision; the server re-checks
 * every gate. After a publish the page re-renders and its status region
 * reads "Published revision N".
 */
export function ValidationControls({
  versionId,
  canValidate,
  publishable,
  expectedProblemVersion,
}: {
  versionId: string;
  canValidate: boolean;
  publishable: boolean;
  expectedProblemVersion: number;
}) {
  const start = useActionRunner();
  const refresh = useActionRunner();
  const publish = useActionRunner();
  const error = publish.error ?? start.error ?? refresh.error;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={!canValidate}
          loading={start.pending}
          onClick={() =>
            start.run(() => startProblemValidation({ versionId }), {
              success: (d) => `Validation started: ${d.runs} model solution run(s) queued on the judge.`,
            })
          }
        >
          {!start.pending && <FlaskConical className="h-4 w-4" aria-hidden />}
          Start validation
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={!canValidate}
          loading={refresh.pending}
          onClick={() => refresh.run(() => refreshValidation({ versionId }))}
        >
          {!refresh.pending && <RefreshCw className="h-4 w-4" aria-hidden />}
          Check progress
        </Button>
        <Button
          type="button"
          disabled={!publishable}
          loading={publish.pending}
          onClick={() =>
            publish.run(() => publishProblemVersion({ versionId, expectedProblemVersion }), {
              success: (d) => `Revision ${d.revision} is now live.`,
            })
          }
        >
          {!publish.pending && <Rocket className="h-4 w-4" aria-hidden />}
          Publish
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
