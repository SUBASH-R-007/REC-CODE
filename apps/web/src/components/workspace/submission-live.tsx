"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { VERDICT_LABEL } from "@recx/shared";
import { ResultPanel } from "@/components/workspace/result-panel";
import { useVerdictStream } from "@/hooks/use-verdict-stream";

/**
 * The full submission page while the submission is still being judged: the
 * same live view as the workspace console (SSE, then backoff polling), and
 * a server refresh once the verdict is final so the page renders it fully.
 */
export function SubmissionLive({ id, sampleIndexes }: { id: string; sampleIndexes: number[] }) {
  const router = useRouter();
  const [target] = useState(() => ({ kind: "submission" as const, id }));
  const stream = useVerdictStream(target);
  const [announcement, setAnnouncement] = useState("");
  const refreshed = useRef(false);

  useEffect(() => {
    const view = stream.view;
    if (stream.phase !== "done" || !view?.terminal || refreshed.current) return;
    refreshed.current = true;
    setAnnouncement(`Submission result: ${VERDICT_LABEL[view.display]}.`);
    router.refresh();
  }, [stream.phase, stream.view, router]);

  return (
    <>
      <ResultPanel target={target} sending={null} stream={stream} sampleIndexes={sampleIndexes} />
      <p aria-live="polite" role="status" className="sr-only">
        {announcement}
      </p>
    </>
  );
}
