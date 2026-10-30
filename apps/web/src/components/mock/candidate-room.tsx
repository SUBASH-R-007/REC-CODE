"use client";

import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Card, CardBody, CardHeader } from "@recx/design";
import { MOCK_INTERVIEW_LIMITS, MOCK_MIRROR_NOTICE } from "@recx/shared";

/** How often the editor is mirrored while the interview runs. */
const PUSH_MS = 4_000;

const LANGUAGES = ["cpp20", "py312", "java21", "js20"] as const;

/**
 * The candidate's half of the room (Phase 12h).
 *
 * A plain textarea on purpose. The workspace's Monaco/CodeMirror pair is
 * lazy-loaded, carries exam telemetry hooks and is tuned for judging; none
 * of that belongs in a conversation, and a mock interview is a
 * conversation with an editor in it. A textarea also means the notice
 * about the mirror sits directly above the thing being mirrored, and no
 * editor chrome can push it off screen.
 *
 * The notice is not a dialog. The interviewer can see this editor for as
 * long as the interview runs, so the sentence saying so stays on screen
 * for exactly that long.
 */
export function CandidateRoom({ interviewId, running }: { interviewId: string; running: boolean }) {
  const [source, setSource] = useState("");
  const [language, setLanguage] = useState<string>("cpp20");
  const [mirrored, setMirrored] = useState<"idle" | "sent" | "failed">("idle");
  const latest = useRef({ source, language });
  latest.current = { source, language };

  useEffect(() => {
    if (!running) return;
    let alive = true;
    let lastSent = "";

    const push = async () => {
      const body = JSON.stringify(latest.current);
      if (body === lastSent) return;
      try {
        const response = await fetch(`/api/mock/${interviewId}/snapshot`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          keepalive: true,
        });
        if (!alive) return;
        // A refusal means the interview ended, or this is not the
        // candidate. Either way: stop claiming it is mirrored.
        setMirrored(response.ok ? "sent" : "failed");
        if (response.ok) lastSent = body;
      } catch {
        if (alive) setMirrored("failed");
      }
    };

    const timer = setInterval(() => void push(), PUSH_MS);
    const onHidden = () => {
      if (document.visibilityState === "hidden") void push();
    };
    document.addEventListener("visibilitychange", onHidden);
    void push();

    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, [interviewId, running]);

  return (
    <Card>
      <CardHeader
        title="Your editor"
        action={
          <span className="flex items-center gap-1.5 text-xs text-text-secondary">
            {running ? <Eye className="h-4 w-4 text-primary" aria-hidden /> : <EyeOff className="h-4 w-4" aria-hidden />}
            {running
              ? mirrored === "failed"
                ? "Not reaching your interviewer"
                : "Your interviewer can see this"
              : "Not shared until it starts"}
          </span>
        }
      />
      <CardBody className="space-y-3">
        <p className="rounded-xl border border-border bg-background p-3 text-sm text-text-secondary">
          {MOCK_MIRROR_NOTICE}
        </p>
        <label className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">Language</span>
          <select
            className="min-h-11 rounded-xl border border-border bg-surface px-3 text-sm"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
          >
            {LANGUAGES.map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
        </label>
        <textarea
          aria-label="Your code, which your interviewer can see"
          className="scroll-thin h-80 w-full rounded-xl border border-border bg-background p-3 font-mono text-sm"
          spellCheck={false}
          maxLength={MOCK_INTERVIEW_LIMITS.snapshotChars}
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="Talk through what you are doing as you write it. That is most of what is being looked at."
        />
      </CardBody>
    </Card>
  );
}
